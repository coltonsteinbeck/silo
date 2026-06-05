import { createRequire } from 'node:module';
import type { logger as coreLogger } from '@silo/core';

type Logger = typeof coreLogger;

export type VoiceEncryptionProvider = 'sodium-native' | 'libsodium-wrappers' | 'tweetnacl';

const providers: VoiceEncryptionProvider[] = ['sodium-native', 'libsodium-wrappers', 'tweetnacl'];

export function loadVoiceEncryptionSupport(log: Logger): VoiceEncryptionProvider | null {
  const require = createRequire(import.meta.url);

  for (const provider of providers) {
    try {
      require(provider);
      log.info(`Loaded ${provider} for voice encryption`);
      return provider;
    } catch {
      // Try the next supported encryption provider.
    }
  }

  log.error('No voice encryption library found. Voice features will not work.');
  return null;
}
