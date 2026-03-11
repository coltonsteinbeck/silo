import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAIProvider } from '../../providers/openai';

describe('OpenAIProvider.generateImage error handling', () => {
    let provider: OpenAIProvider;
    let consoleErrorSpy: ReturnType<typeof mock>;
    let originalConsoleError: typeof console.error;

    beforeEach(() => {
        provider = new OpenAIProvider('sk-test');
        consoleErrorSpy = mock(() => { });
        originalConsoleError = console.error;
        console.error = consoleErrorSpy as any;
    });

    afterEach(() => {
        console.error = originalConsoleError;
    });

    test('redacts secrets in thrown error messages and logs', async () => {
        const fakeSecret = 'sk-super-secret-123';
        const fakeBearer = 'Bearer token-value-123';
        const fakeXai = 'xai-sensitive-token';

        (provider as any).client = {
            images: {
                generate: mock(async () => {
                    throw new Error(`boom ${fakeSecret} ${fakeBearer} ${fakeXai}`);
                })
            }
        };

        let thrownMessage = '';
        try {
            await provider.generateImage('draw cat');
        } catch (error) {
            thrownMessage = error instanceof Error ? error.message : String(error);
        }

        const loggedOutput = consoleErrorSpy.mock.calls
            .flatMap(call => call.map(part => String(part)))
            .join(' ');

        expect(thrownMessage).toContain('OpenAI image generation failed:');
        expect(thrownMessage).toContain('[redacted-key]');
        expect(thrownMessage).toContain('Bearer [redacted-token]');
        expect(thrownMessage).not.toContain(fakeSecret);
        expect(thrownMessage).not.toContain(fakeBearer);
        expect(thrownMessage).not.toContain(fakeXai);

        expect(loggedOutput).toContain('[redacted-key]');
        expect(loggedOutput).toContain('Bearer [redacted-token]');
        expect(loggedOutput).not.toContain(fakeSecret);
        expect(loggedOutput).not.toContain(fakeBearer);
        expect(loggedOutput).not.toContain(fakeXai);
    });

    test('throws on malformed image response payload', async () => {
        (provider as any).client = {
            images: {
                generate: mock(async () => ({ data: [] }))
            }
        };

        await expect(provider.generateImage('draw cat')).rejects.toThrow(
            'OpenAI image generation failed: No image data from OpenAI'
        );
    });

    test('throws when response has no url and no base64 data', async () => {
        (provider as any).client = {
            images: {
                generate: mock(async () => ({ data: [{}] }))
            }
        };

        await expect(provider.generateImage('draw cat')).rejects.toThrow(
            'OpenAI image generation failed: No image URL from OpenAI'
        );
    });
});
