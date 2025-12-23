# Contributing to Silo

Thank you for your interest in contributing to Silo! This document provides comprehensive guidelines for contributing to the project following open-source best practices.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Security Guidelines](#security-guidelines)

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment. We expect all contributors to:

- Be respectful and welcoming to all participants
- Accept constructive criticism gracefully
- Focus on what is best for the community
- Show empathy towards other community members

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.0.0
- PostgreSQL >= 14
- Redis >= 7.0
- Discord Bot Application
- OpenAI API Key (or Anthropic/xAI)

### Development Setup

1. **Fork and clone the repository:**

   ```bash
   git clone https://github.com/YOUR_USERNAME/silo.git
   cd silo
   ```

2. **Install dependencies:**

   ```bash
   bun install
   ```

3. **Set up Git hooks:**

   ```bash
   bun run prepare
   ```

4. **Configure environment:**

   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

5. **Start infrastructure (PostgreSQL + Redis):**

   ```bash
   docker-compose up -d
   ```

6. **Run database migrations:**

   ```bash
   bun run migrate
   ```

7. **Verify setup:**

   ```bash
   bun run test
   bun run type-check
   bun run lint
   ```

8. **Start development server:**
   ```bash
   bun run dev:bot
   ```

## Development Workflow

### Branch Naming

Use descriptive branch names with a type prefix:

```
feat/voice-channel-selection
fix/opus-encoder-cleanup
docs/contributing-guide
test/voice-session-coverage
chore/update-dependencies
```

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/). Each commit message should have the format:

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**Types:**

| Type       | Description                                           |
| ---------- | ----------------------------------------------------- |
| `feat`     | New feature                                           |
| `fix`      | Bug fix                                               |
| `docs`     | Documentation only changes                            |
| `style`    | Code style changes (formatting, missing semicolons)   |
| `refactor` | Code change that neither fixes a bug nor adds feature |
| `perf`     | Performance improvement                               |
| `test`     | Adding or modifying tests                             |
| `chore`    | Build process or auxiliary tool changes               |
| `security` | Security-related changes                              |

**Examples:**

```bash
feat(voice): add channel selection for /speak command
fix(opus): remove encoder.delete() call causing crash
docs(readme): update voice feature documentation
test(commands): add memory command coverage
security(sanitizer): add input validation for user content
```

### Development Commands

```bash
# Development
bun run dev:bot         # Start bot with hot reload
bun run test:watch      # Run tests in watch mode

# Quality checks
bun run lint            # Check for linting errors
bun run lint:fix        # Auto-fix linting issues
bun run format          # Format code with Prettier
bun run format:check    # Check formatting
bun run type-check      # TypeScript type checking

# Testing
bun run test            # Run all tests
bun run test:coverage   # Run tests with coverage report
```

## Code Standards

### TypeScript Best Practices

We use TypeScript in strict mode. Follow these guidelines:

1. **Enable strict null checks** - All `null` and `undefined` must be handled explicitly
2. **Avoid `any` type** - Use proper typing or `unknown` when type is truly unknown
3. **Use interfaces for objects** - Define clear contracts for data structures
4. **Prefer `const` assertions** - Use `as const` for literal types

```typescript
// ✅ Good
interface UserData {
  id: string;
  name: string;
  role?: 'admin' | 'member';
}

function getUser(id: string): UserData | null {
  const user = users.get(id);
  return user ?? null;
}

// ❌ Bad
function getUser(id: any): any {
  return users.get(id);
}
```

### Error Handling

Always handle errors explicitly:

```typescript
// ✅ Good - Explicit error handling
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  logger.error('Operation failed:', error);
  throw new CustomError('Operation failed', { cause: error });
}

// ❌ Bad - Swallowing errors
try {
  await riskyOperation();
} catch {
  // Silent failure
}
```

### Logging

Use the structured logger from `@silo/core`:

```typescript
import { logger } from '@silo/core';

// Use appropriate log levels
logger.debug('Detailed debugging info');
logger.info('General operational info');
logger.warn('Warning conditions');
logger.error('Error conditions');
```

### Async/Await

Always use async/await over raw promises:

```typescript
// ✅ Good
async function fetchData(): Promise<Data[]> {
  const results = await Promise.all([fetchA(), fetchB()]);
  return results.flat();
}

// ❌ Bad
function fetchData(): Promise<Data[]> {
  return Promise.all([fetchA(), fetchB()]).then(results => results.flat());
}
```

## Security Guidelines

Security is critical for a Discord bot handling user data. Follow these guidelines:

### Input Validation

Always validate and sanitize user input:

```typescript
import { contentSanitizer } from './security';

// Validate all user-provided content
const sanitized = contentSanitizer.sanitize(userInput);
if (!contentSanitizer.validate(sanitized)) {
  throw new Error('Invalid input');
}
```

### Secrets Management

**Never commit secrets or credentials to the repository.**

- Store all secrets in environment variables (`.env` files)
- Ensure `.env` files are in `.gitignore`
- Use GitHub Secrets for CI/CD workflows
- For production, use secret management tools (e.g., Supabase Vault, AWS Secrets Manager)
- Enable secret scanning in CI (GitHub secret scanning, pre-commit hooks)
- If a secret is accidentally committed:
  1. Rotate/revoke it immediately
  2. Remove from git history (`git filter-branch` or BFG)
  3. Report to security team

See [SECURITY.md](../SECURITY.md) for vulnerability reporting.

**Recommended patterns:**
```typescript
// ✅ Good: Use environment variables
const apiKey = process.env.OPENAI_API_KEY;

// ❌ Bad: Hard-coded secrets
const apiKey = 'sk-1234...';
```