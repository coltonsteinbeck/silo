# Contributing to Silo

Thank you for your interest in contributing to Silo! This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.0.0
- PostgreSQL >= 14
- Discord Bot Application
- OpenAI API Key (or Anthropic/xAI)

### Development Setup

1. **Clone the repository:**

   ```bash
   git clone https://github.com/yourusername/silo.git
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

5. **Run database migrations:**

   ```bash
   bun run migrate
   ```

6. **Run tests:**

   ```bash
   bun run test
   ```

7. **Start development server:**
   ```bash
   bun run dev:bot
   ```

## Development Workflow

### Code Style

- We use TypeScript strict mode
- Run `bun run lint` before committing
- Format code with `bun run format`
- All code must pass `bun run type-check`

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: bug fix
docs: documentation changes
test: test changes
chore: maintenance tasks
```

Examples:

- `feat: add /analytics quotas subcommand`
- `fix: align quota adapter with database schema`
- `docs: update Mac mini deployment guide`

### Testing

- Write tests for all new features
- Maintain test coverage above 80%
- Run `bun run test:watch` during development
- All tests must pass before PR merge

### Pull Requests

1. **Create a feature branch:**

   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes:**
   - Write clean, documented code
   - Add tests
   - Update documentation

3. **Commit with conventional commits:**

   ```bash
   git add .
   git commit -m "feat: describe your feature"
   ```

4. **Push and create PR:**

   ```bash
   git push origin feat/your-feature-name
   ```

5. **PR Requirements:**
   - Clear description of changes
   - All tests passing
   - No TypeScript errors
   - Code review approval

## Project Structure

```
silo/
├── packages/
│   ├── core/          # Shared utilities and types
│   └── bot/           # Discord bot implementation
├── database/
│   └── migrations/    # SQL migrations
├── scripts/           # Build and deployment scripts
└── ecosystem.config.js # PM2 configuration
```

## Key Areas

### Adding Commands

Commands live in `packages/bot/src/commands/`:

```typescript
import { SlashCommandBuilder } from 'discord.js';
import { Command } from './types';

export class MyCommand implements Command {
  public readonly data = new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('Description');

  async execute(interaction) {
    // Implementation
  }
}
```

### Database Changes

1. Create a new migration in `database/migrations/`
2. Number it sequentially: `006_feature_name.sql`
3. Make it idempotent (use `IF NOT EXISTS`)
4. Test with `bun run migrate`

### Provider Integration

Providers live in `packages/bot/src/providers/`:

- Implement the provider interface
- Register in `registry.ts`
- Add configuration in `config/schema.ts`

## Code Review Process

1. PRs require one approval
2. Address all review comments
3. Keep PRs focused and small
4. Update docs with code changes

## Getting Help

- Open an issue for bugs
- Use discussions for questions
- Join our Discord for chat

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
