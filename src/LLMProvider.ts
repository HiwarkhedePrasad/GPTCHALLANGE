/**
 * OmniCode LLM Providers
 * Supports: OpenAI, Anthropic (Claude), Google Gemini
 */

// ============================================================================
// TYPES
// ============================================================================

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, {
                type: string;
                description: string;
                enum?: string[];
            }>;
            required: string[];
        };
    };
}

export interface LLMResponse {
    content: string | null;
    tool_calls?: ToolCall[];
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface LLMProviderConfig {
    apiKey: string;
    model: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
}

export interface LLMProvider {
    name: string;
    chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse>;
}

export type ProviderType = 'openai' | 'anthropic' | 'gemini';

// ============================================================================
// OPENAI PROVIDER
// ============================================================================

class OpenAIProvider implements LLMProvider {
    name = 'openai';
    private config: LLMProviderConfig;

    constructor(config: LLMProviderConfig) {
        this.config = {
            maxTokens: 4096,
            temperature: 0.7,
            ...config,
        };
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
        const body: Record<string, unknown> = {
            model: this.config.model,
            messages: messages.map(m => this.formatMessage(m)),
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
        };

        if (tools && tools.length > 0) {
            body.tools = tools;
            body.tool_choice = 'auto';
        }

        const baseUrl = this.config.baseUrl || 'https://api.openai.com/v1';
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
            choices: Array<{
                message: { content: string | null; tool_calls?: ToolCall[] };
                finish_reason: string;
            }>;
        };
        const choice = data.choices[0];
        const message = choice.message;

        return {
            content: message.content,
            tool_calls: message.tool_calls,
            finish_reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' :
                choice.finish_reason === 'length' ? 'length' : 'stop',
        };
    }

    private formatMessage(msg: LLMMessage): Record<string, unknown> {
        const formatted: Record<string, unknown> = {
            role: msg.role,
            content: msg.content,
        };
        if (msg.tool_calls) { formatted.tool_calls = msg.tool_calls; }
        if (msg.tool_call_id) { formatted.tool_call_id = msg.tool_call_id; }
        if (msg.name) { formatted.name = msg.name; }
        return formatted;
    }
}

// ============================================================================
// ANTHROPIC PROVIDER
// ============================================================================

class AnthropicProvider implements LLMProvider {
    name = 'anthropic';
    private config: LLMProviderConfig;

    constructor(config: LLMProviderConfig) {
        this.config = {
            maxTokens: 4096,
            temperature: 0.7,
            ...config,
        };
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
        const systemMessage = messages.find(m => m.role === 'system');
        const conversationMessages = messages.filter(m => m.role !== 'system');

        const body: Record<string, unknown> = {
            model: this.config.model,
            max_tokens: this.config.maxTokens,
            messages: conversationMessages.map(m => this.formatMessage(m)),
        };

        if (systemMessage) {
            body.system = systemMessage.content;
        }

        if (tools && tools.length > 0) {
            body.tools = tools.map(t => ({
                name: t.function.name,
                description: t.function.description,
                input_schema: t.function.parameters,
            }));
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
            content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
            stop_reason: string;
        };
        return this.parseResponse(data);
    }

    private formatMessage(msg: LLMMessage): Record<string, unknown> {
        if (msg.role === 'assistant' && msg.tool_calls) {
            return {
                role: 'assistant',
                content: msg.tool_calls.map(tc => ({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: JSON.parse(tc.function.arguments),
                })),
            };
        }

        if (msg.role === 'tool') {
            return {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: msg.content,
                }],
            };
        }

        return {
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content,
        };
    }

    private parseResponse(data: { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason: string }): LLMResponse {
        let textContent = '';
        const toolCalls: ToolCall[] = [];

        for (const block of data.content) {
            if (block.type === 'text') {
                textContent += block.text || '';
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id || '',
                    type: 'function',
                    function: {
                        name: block.name || '',
                        arguments: JSON.stringify(block.input),
                    },
                });
            }
        }

        return {
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' :
                data.stop_reason === 'max_tokens' ? 'length' : 'stop',
        };
    }
}

// ============================================================================
// GEMINI PROVIDER
// ============================================================================

class GeminiProvider implements LLMProvider {
    name = 'gemini';
    private config: LLMProviderConfig;

    constructor(config: LLMProviderConfig) {
        this.config = {
            maxTokens: 4096,
            temperature: 0.7,
            ...config,
        };
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
        const geminiMessages = this.formatMessages(messages);

        const body: Record<string, unknown> = {
            contents: geminiMessages,
            generationConfig: {
                maxOutputTokens: this.config.maxTokens,
                temperature: this.config.temperature,
            },
        };

        if (tools && tools.length > 0) {
            body.tools = [{
                functionDeclarations: tools.map(t => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                })),
            }];
        }

        const systemMsg = messages.find(m => m.role === 'system');
        if (systemMsg) {
            body.systemInstruction = { parts: [{ text: systemMsg.content }] };
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent?key=${this.config.apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Gemini API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
            candidates?: Array<{
                content: { parts: Array<{ text?: string; functionCall?: { name: string; args: unknown } }> };
                finishReason: string;
            }>;
        };
        return this.parseResponse(data);
    }

    private formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
        const result: Array<Record<string, unknown>> = [];

        for (const msg of messages) {
            if (msg.role === 'system') continue;

            if (msg.role === 'tool') {
                result.push({
                    role: 'function',
                    parts: [{
                        functionResponse: {
                            name: msg.name,
                            response: { result: msg.content },
                        },
                    }],
                });
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                result.push({
                    role: 'model',
                    parts: msg.tool_calls.map(tc => ({
                        functionCall: {
                            name: tc.function.name,
                            args: JSON.parse(tc.function.arguments),
                        },
                    })),
                });
            } else {
                result.push({
                    role: msg.role === 'user' ? 'user' : 'model',
                    parts: [{ text: msg.content }],
                });
            }
        }

        return result;
    }

    private parseResponse(data: { candidates?: Array<{ content: { parts: Array<{ text?: string; functionCall?: { name: string; args: unknown } }> }; finishReason: string }> }): LLMResponse {
        if (!data.candidates || data.candidates.length === 0) {
            return { content: null, finish_reason: 'error' };
        }

        const candidate = data.candidates[0];
        const parts = candidate.content.parts;

        let textContent = '';
        const toolCalls: ToolCall[] = [];

        for (const part of parts) {
            if (part.text) {
                textContent += part.text;
            } else if (part.functionCall) {
                toolCalls.push({
                    id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args),
                    },
                });
            }
        }

        return {
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' :
                candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
        };
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export const DEFAULT_MODELS: Record<ProviderType, string> = {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-20250514',
    gemini: 'gemini-1.5-pro',
};

export function createLLMProvider(type: ProviderType, config: LLMProviderConfig): LLMProvider {
    switch (type) {
        case 'openai':
            return new OpenAIProvider(config);
        case 'anthropic':
            return new AnthropicProvider(config);
        case 'gemini':
            return new GeminiProvider(config);
        default:
            throw new Error(`Unknown LLM provider: ${type}`);
    }
}
