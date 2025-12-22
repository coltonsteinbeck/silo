# Contributing to Silo

Thank you for your interest in contributing to Silo! This document provides comprehensive guidelines for contributing to the project following open-source best practices.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Security Guidelines](#security-guidelines)
- [Testing Requirements](#testing-requirements)
- [Pull Request Process](#pull-request-process)
- [Code Review Guidelines](#code-review-guidelines)
- [Project Structure](#project-structure)
- [Getting Help](#getting-help)

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

1. **Never commit secrets** - Use `.env` files (already in `.gitignore`)
2. **Use environment variables** - Access secrets via `process.env`
3. **Validate on startup** - Check required variables exist before running
4. **Rotate regularly** - Update API keys and tokens periodically

```typescript
// ✅ Good - Validate on startup
const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error('DISCORD_TOKEN is required');
}

// ❌ Bad - Using secrets inline
const token = 'mfa.AbCdEf123...'; // NEVER DO THIS
```

### Dependency Security

1. **Audit regularly**: Run `bun audit` to check for vulnerabilities
2. **Pin versions**: Use exact versions for critical dependencies
3. **Review updates**: Check changelogs before updating major versions
4. **Minimize dependencies**: Only add packages that are truly necessary

### SQL Injection Prevention

Always use parameterized queries:

```typescript
// ✅ Good - Parameterized query
const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);

// ❌ Bad - String interpolation
const result = await pool.query(`SELECT * FROM users WHERE id = '${userId}'`);
```

### Rate Limiting

Respect API rate limits and implement client-side throttling:

```typescript
import { rateLimiter } from '@silo/core';

// Check rate limit before expensive operations
const { allowed, remaining } = rateLimiter.check(userId, 'images');
if (!allowed) {
  return interaction.reply('Rate limit exceeded. Try again later.');
}
```

### Permissions

Always verify user permissions before sensitive operations:

```typescript
import { permissionManager } from './permissions';

// Check permissions before admin actions
const isAdmin = await permissionManager.isAdmin(interaction.user.id, guildId);
if (!isAdmin) {
  return interaction.reply({
    content: 'Admin permission required',
    ephemeral: true
  });
}
```

## Testing Requirements

### Coverage Expectations

- **Minimum coverage**: 80% for new code
- **Critical paths**: 100% coverage for security and data handling code
- **All commands**: Must have corresponding test files

### Test Structure

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createMockInteraction, createMockDatabase } from '@silo/core';

describe('MyCommand', () => {
  let command: MyCommand;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
    command = new MyCommand(mockDb);
  });

  describe('execute', () => {
    it('should handle valid input', async () => {
      const interaction = createMockInteraction({
        /* options */
      });
      await command.execute(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('Success'));
    });

    it('should reject invalid input', async () => {
      const interaction = createMockInteraction({ invalid: true });
      await expect(command.execute(interaction)).rejects.toThrow('Invalid input');
    });
  });
});
```

### Test Best Practices

1. **Descriptive names**: Test names should describe the behavior being tested
2. **Arrange-Act-Assert**: Structure tests with clear sections
3. **Mock external services**: Use mocks from `@silo/core` for Discord, database, etc.
4. **Test edge cases**: Include tests for error conditions and boundary cases
5. **Isolated tests**: Each test should be independent and repeatable

## Pull Request Process

### Before Submitting

1. **Create a feature branch** from `main`
2. **Make focused commits** with clear messages
3. **Run all checks**:
   ```bash
   bun run test
   bun run type-check
   bun run lint
   bun run format:check
   ```
4. **Update documentation** if adding new features
5. **Add tests** for new functionality

### PR Template

Your PR description should include:

```markdown
## Description

Brief description of changes

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update

## Testing

Describe the tests you ran to verify your changes

## Checklist

- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code where necessary
- [ ] I have updated the documentation accordingly
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix/feature works
- [ ] All tests pass locally
```

### After Submitting

1. **Respond to feedback** promptly
2. **Keep PR updated** with main branch
3. **Request re-review** after making changes
4. **Squash commits** if requested before merge

## Code Review Guidelines

### For Authors

- Keep PRs small and focused (< 400 lines when possible)
- Provide context in PR description
- Respond to all comments
- Be open to suggestions

### For Reviewers

- Review within 48 hours when possible
- Be constructive and specific
- Approve when changes are acceptable
- Use "Request changes" only for blocking issues

### Review Checklist

- [ ] Code is readable and well-documented
- [ ] No security vulnerabilities introduced
- [ ] Tests cover new functionality
- [ ] No unnecessary dependencies added
- [ ] Error handling is appropriate
- [ ] Performance considerations addressed
- [ ] Follows project conventions

## Project Structure

```
silo/
├── packages/
│   ├── core/                 # Shared utilities and types
│   │   └── src/
│   │       ├── config/       # Configuration schema and loader
│   │       ├── types/        # Shared TypeScript types
│   │       └── utils/        # Utilities (logger, rate-limiter)
│   └── bot/                  # Discord bot implementation
│       └── src/
│           ├── commands/     # Slash command handlers
│           ├── database/     # Database adapters
│           ├── health/       # Health check server
│           ├── middleware/   # Request middleware (quotas)
│           ├── permissions/  # Permission management
│           ├── providers/    # AI provider integrations
│           ├── security/     # Security utilities
│           └── voice/        # Voice session management
├── database/
│   └── migrations/           # SQL migrations (numbered)
├── scripts/                  # Setup and deployment scripts
├── logs/                     # Application logs (git-ignored)
├── eslint.config.js          # ESLint configuration
├── tsconfig.json             # TypeScript configuration
├── bunfig.toml               # Bun configuration
└── docker-compose.yml        # Local infrastructure
```

### Adding New Commands

Commands are located in `packages/bot/src/commands/`:

```typescript
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { Command } from './types';

export class MyCommand implements Command {
  public readonly data = new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('What this command does')
    .addStringOption(option =>
      option.setName('input').setDescription('Input description').setRequired(true)
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const input = interaction.options.getString('input', true);
    // Implementation...

    await interaction.editReply('Response');
  }
}
```

Don't forget to:

1. Export the command in `commands/index.ts`
2. Add tests in `__tests__/commands/`
3. Update documentation if user-facing

### Database Changes

1. Create a new migration file in `database/migrations/`
2. Use sequential numbering: `006_feature_name.sql`
3. Make migrations idempotent with `IF NOT EXISTS`
4. Test with `bun run migrate`
5. Update type definitions in `packages/core/src/types/`

## Getting Help

- **Issues**: Open a GitHub issue for bugs or feature requests
- **Discussions**: Use GitHub Discussions for questions
- **Discord**: Join our Discord server for real-time help

## License

By contributing to Silo, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Silo! 🎉
