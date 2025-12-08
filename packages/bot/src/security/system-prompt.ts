/**
 * System Prompt Security Module
 * 
 * Handles validation, sanitization, and secure loading of system prompts.
 * 
 * Features:
 * - Database-stored prompts per guild (via Discord commands)
 * - File-based prompts for self-hosters (SYSTEM_PROMPT_PATH env var)
 * - Jailbreak detection and sanitization
 * - Prompt injection prevention
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { resolve } from 'path';
import { logger } from '@silo/core';
import { deploymentDetector } from './deployment';

// Maximum prompt length (characters)
export const MAX_PROMPT_LENGTH = 4000;

// Suspicious patterns that might indicate prompt injection
const JAILBREAK_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(instructions?|prompts?|rules?)/i,
  /forget\s+(all\s+)?(instructions?|prompts?|everything)/i,
  /you\s+are\s+now\s+(a\s+)?(?:dan|jailbreak|evil)/i,
  /system:\s*override/i,
  /\[system\].*override/i,
  /do\s+anything\s+now/i,
  /bypass\s+(all\s+)?(filters?|restrictions?|safety)/i,
  /pretend\s+(?:you\s+are|to\s+be)\s+(?:unrestricted|evil|harmful)/i,
  /act\s+as\s+(?:if\s+you\s+have\s+)?no\s+(ethical\s+)?guidelines/i,
];

// Patterns that should be escaped/neutralized
const DANGEROUS_PATTERNS = [
  /```system/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<\|system\|>/gi,
  /<\|user\|>/gi,
  /<\|assistant\|>/gi,
];

export interface SystemPromptConfig {
  /** The validated system prompt */
  prompt: string | null;
  /** Whether this prompt is enabled */
  enabled: boolean;
  /** Source of the prompt */
  source: 'database' | 'file' | 'default';
  /** Any warnings about the prompt */
  warnings: string[];
}

export interface SystemPromptValidationResult {
  valid: boolean;
  sanitizedPrompt: string | null;
  warnings: string[];
  errors: string[];
}

/**
 * System Prompt Manager
 * 
 * Manages system prompts from multiple sources:
 * 1. Database (per-guild, set via Discord commands)
 * 2. File system (self-hosters can use SYSTEM_PROMPT_PATH)
 * 3. Default prompt (fallback)
 */
class SystemPromptManager {
  private filePrompt: string | null = null;
  private filePromptPath: string | null = null;
  private fileWatcherActive = false;
  private defaultPrompt: string = '';

  constructor() {
    this.loadFilePrompt();
  }

  /**
   * Load system prompt from file (for self-hosters)
   */
  private loadFilePrompt(): void {
    const promptPath = process.env.SYSTEM_PROMPT_PATH;
    
    if (!promptPath) {
      return;
    }

    const resolvedPath = resolve(promptPath);
    
    if (!existsSync(resolvedPath)) {
      logger.warn(`System prompt file not found: ${resolvedPath}`);
      return;
    }

    try {
      const content = readFileSync(resolvedPath, 'utf-8');
      const validation = this.validatePrompt(content);
      
      if (validation.valid) {
        this.filePrompt = validation.sanitizedPrompt;
        this.filePromptPath = resolvedPath;
        logger.info(`Loaded system prompt from file: ${resolvedPath} (${content.length} chars)`);
        
        if (validation.warnings.length > 0) {
          logger.warn(`System prompt warnings: ${validation.warnings.join(', ')}`);
        }

        // Watch for changes (hot reload)
        this.setupFileWatcher(resolvedPath);
      } else {
        logger.error(`Invalid system prompt file: ${validation.errors.join(', ')}`);
      }
    } catch (error) {
      logger.error(`Failed to read system prompt file: ${error}`);
    }
  }

  /**
   * Set up file watcher for hot reloading
   */
  private setupFileWatcher(path: string): void {
    if (this.fileWatcherActive) {
      return;
    }

    watchFile(path, { interval: 5000 }, () => {
      logger.info('System prompt file changed, reloading...');
      this.loadFilePrompt();
    });

    this.fileWatcherActive = true;
  }

  /**
   * Clean up file watcher
   */
  cleanup(): void {
    if (this.filePromptPath && this.fileWatcherActive) {
      unwatchFile(this.filePromptPath);
      this.fileWatcherActive = false;
    }
  }

  /**
   * Validate a system prompt for security issues
   */
  validatePrompt(prompt: string): SystemPromptValidationResult {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Check length
    if (prompt.length > MAX_PROMPT_LENGTH) {
      errors.push(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
      return { valid: false, sanitizedPrompt: null, warnings, errors };
    }

    // Check for empty prompt
    if (!prompt.trim()) {
      return { valid: true, sanitizedPrompt: null, warnings, errors };
    }

    let sanitizedPrompt = prompt;

    // Check for jailbreak patterns
    for (const pattern of JAILBREAK_PATTERNS) {
      if (pattern.test(prompt)) {
        // In production, reject outright
        const config = deploymentDetector.getConfig();
        if (config.isProduction) {
          errors.push('Prompt contains potentially harmful instructions');
          return { valid: false, sanitizedPrompt: null, warnings, errors };
        }
        // In dev/self-hosted, warn but allow
        warnings.push('Prompt contains suspicious patterns (allowed in non-production mode)');
        break;
      }
    }

    // Neutralize dangerous patterns (escape them)
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(sanitizedPrompt)) {
        sanitizedPrompt = sanitizedPrompt.replace(pattern, (match) => {
          warnings.push(`Neutralized pattern: ${match}`);
          return `[${match.replace(/[<>[\]|]/g, '')}]`;
        });
      }
    }

    // Check for excessive special characters that might indicate injection
    const specialCharRatio = (sanitizedPrompt.match(/[<>[\]{}|\\]/g) || []).length / sanitizedPrompt.length;
    if (specialCharRatio > 0.1) {
      warnings.push('High ratio of special characters detected');
    }

    return { valid: true, sanitizedPrompt: sanitizedPrompt.trim(), warnings, errors };
  }

  /**
   * Get the effective system prompt for a guild
   * 
   * Priority:
   * 1. Database prompt (if set and enabled)
   * 2. File prompt (for self-hosters)
   * 3. Default prompt
   */
  getEffectivePrompt(
    dbPrompt: string | null,
    dbEnabled: boolean,
    _forVoice = false // Reserved for future voice-specific prompt handling
  ): SystemPromptConfig {
    const warnings: string[] = [];
    const config = deploymentDetector.getConfig();

    // 1. Database prompt (highest priority)
    if (dbPrompt && dbEnabled) {
      const validation = this.validatePrompt(dbPrompt);
      if (validation.valid && validation.sanitizedPrompt) {
        return {
          prompt: validation.sanitizedPrompt,
          enabled: true,
          source: 'database',
          warnings: validation.warnings
        };
      }
      warnings.push(...validation.errors);
    }

    // 2. File prompt (for self-hosters)
    if (this.filePrompt && config.isSelfHosted) {
      return {
        prompt: this.filePrompt,
        enabled: true,
        source: 'file',
        warnings
      };
    }

    // 3. Default prompt
    if (this.defaultPrompt) {
      return {
        prompt: this.defaultPrompt,
        enabled: true,
        source: 'default',
        warnings
      };
    }

    // No prompt configured
    return {
      prompt: null,
      enabled: false,
      source: 'default',
      warnings
    };
  }

  /**
   * Set the default system prompt (used as fallback)
   */
  setDefaultPrompt(prompt: string): void {
    const validation = this.validatePrompt(prompt);
    if (validation.valid) {
      this.defaultPrompt = validation.sanitizedPrompt || '';
    }
  }

  /**
   * Get info about file prompt configuration
   */
  getFilePromptInfo(): { configured: boolean; path: string | null; length: number } {
    return {
      configured: this.filePrompt !== null,
      path: this.filePromptPath,
      length: this.filePrompt?.length ?? 0
    };
  }
}

// Export singleton instance
export const systemPromptManager = new SystemPromptManager();
export default systemPromptManager;
