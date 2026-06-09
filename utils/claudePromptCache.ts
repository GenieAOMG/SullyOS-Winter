/**
 * Optional Claude prompt-cache adapter.
 *
 * The project still builds the same system prompt string. When enabled, only the
 * first stable role-foundation prefix is converted into a text block with
 * Anthropic cache_control. If the upstream rejects that shape, callers should
 * surface the error instead of silently falling back.
 */

const CACHE_BREAK_MARKERS = [
    // Preferred boundary: cache role foundation + stable/semistable memory
    // bank, then stop before per-turn Memory Palace vector recall.
    '### 记忆宫殿 (Memory Palace)',
    // Fallback when Memory Palace is disabled: cache the core context and stop
    // before realtime clock/weather/news injection.
    '### 【当前时间】',
    // Last conservative fallback used when neither boundary is present.
    '### 记忆系统 (Memory Bank)',
];

export interface ClaudePromptCacheStats {
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    cachedInputTokens?: number;
}

export interface ClaudeNativeShadowReport {
    ok: boolean;
    systemEqual: boolean;
    messageCountEqual: boolean;
    messageRolesEqual: boolean;
    messageContentEqual: boolean;
    systemChars: number;
    systemFingerprint: string;
    messageCount: number;
    roleSequenceFingerprint: string;
    contentSequenceFingerprint: string;
    nativeShape: {
        systemBlocks: number;
        messages: number;
    };
}

export interface ClaudeNativeRequest {
    url: string;
    body: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system: any[];
        messages: Array<{ role: string; content: any }>;
    };
}

export interface ClaudeNativePayloadSummary {
    shadowOk: boolean | null;
    actualSystemEqual: boolean;
    actualMessageEqual: boolean;
    openAiSystemChars: number | null;
    openAiMessageChars: number;
    openAiMessageCount: number;
    nativeSystemChars: number;
    nativeMessageChars: number;
    nativeMessageCount: number;
    cacheBlockChars: number;
    cacheBlockFingerprint: string;
}

export function shouldUseClaudePromptCache(input: {
    enabled?: boolean;
    model?: string;
}): boolean {
    return !!input.enabled && /(?:^|[^\w])claude[-_]/i.test((input.model || '').trim());
}

export function shouldUseClaudeNativeMode(input: {
    cacheEnabled?: boolean;
    nativeEnabled?: boolean;
    model?: string;
}): boolean {
    return shouldUseClaudePromptCache({
        enabled: !!input.cacheEnabled && !!input.nativeEnabled,
        model: input.model,
    });
}

export function withClaudePromptCache<T extends { role: string; content: any }>(
    messages: T[],
): T[] {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const firstSystemIndex = messages.findIndex(m => m?.role === 'system' && typeof m.content === 'string');
    if (firstSystemIndex < 0) return messages;

    const firstSystem = messages[firstSystemIndex];
    const text = firstSystem.content as string;
    const markerIndex = CACHE_BREAK_MARKERS
        .map(marker => text.indexOf(marker))
        .find(index => index > 0) ?? -1;
    if (markerIndex <= 0) return messages;

    const stablePrefix = text.slice(0, markerIndex).trimEnd();
    const dynamicRest = text.slice(markerIndex);
    if (!stablePrefix || !dynamicRest) return messages;

    const next = messages.slice();
    next[firstSystemIndex] = {
        ...firstSystem,
        content: [
            {
                type: 'text',
                text: stablePrefix,
                cache_control: { type: 'ephemeral' },
            },
            {
                type: 'text',
                text: `\n\n${dynamicRest}`,
            },
        ],
    };
    return next;
}

const blockText = (content: any): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(block => {
        if (typeof block === 'string') return block;
        if (typeof block?.text === 'string') return block.text;
        return '';
    }).join('');
};

const normalizeMessageContent = (content: any): string => blockText(content).replace(/\r\n/g, '\n');

export function buildClaudeNativeShadowReport(openAiBody: {
    messages?: Array<{ role: string; content: any }>;
}): ClaudeNativeShadowReport | null {
    const messages = openAiBody.messages;
    if (!Array.isArray(messages)) return null;

    const systemMessages = messages.filter(m => m?.role === 'system');
    if (systemMessages.length === 0) return null;

    const openAiSystemParts = systemMessages.map(m => blockText(m.content));
    const openAiSystemText = openAiSystemParts.join('\n\n').replace(/\r\n/g, '\n');
    const nativeSystem = systemMessages.flatMap((m, index) => {
        const blocks = Array.isArray(m.content)
            ? m.content
            : [{ type: 'text', text: String(m.content ?? '') }];
        if (index === 0) return blocks;
        return [{ type: 'text', text: '\n\n' }, ...blocks];
    });
    const nativeSystemText = nativeSystem.map(block => blockText([block])).join('').replace(/\r\n/g, '\n');

    const openAiNonSystem = messages.filter(m => m?.role !== 'system');
    const nativeMessages = openAiNonSystem.map(m => ({ role: m.role, content: m.content }));

    const openAiRoles = openAiNonSystem.map(m => m.role).join('|');
    const nativeRoles = nativeMessages.map(m => m.role).join('|');
    const openAiContents = openAiNonSystem.map(m => normalizeMessageContent(m.content));
    const nativeContents = nativeMessages.map(m => normalizeMessageContent(m.content));
    const openAiContentJoined = openAiContents.join('\n---message-boundary---\n');
    const nativeContentJoined = nativeContents.join('\n---message-boundary---\n');

    const systemEqual = openAiSystemText === nativeSystemText;
    const messageCountEqual = openAiNonSystem.length === nativeMessages.length;
    const messageRolesEqual = openAiRoles === nativeRoles;
    const messageContentEqual = openAiContentJoined === nativeContentJoined;

    return {
        ok: systemEqual && messageCountEqual && messageRolesEqual && messageContentEqual,
        systemEqual,
        messageCountEqual,
        messageRolesEqual,
        messageContentEqual,
        systemChars: openAiSystemText.length,
        systemFingerprint: fingerprintText(openAiSystemText),
        messageCount: openAiNonSystem.length,
        roleSequenceFingerprint: fingerprintText(openAiRoles),
        contentSequenceFingerprint: fingerprintText(openAiContentJoined),
        nativeShape: {
            systemBlocks: nativeSystem.length,
            messages: nativeMessages.length,
        },
    };
}

export function buildAnthropicMessagesUrl(baseUrl: string): string {
    const base = baseUrl.trim().replace(/\/+$/, '');
    if (/\/v1$/i.test(base)) return `${base}/messages`;
    if (/\/v1\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/messages');
    if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/v1/messages');
    return `${base}/v1/messages`;
}

export function toClaudeNativeRequest(openAiBody: {
    model: string;
    messages: Array<{ role: string; content: any }>;
    temperature?: number;
    max_tokens?: number;
}, baseUrl: string): ClaudeNativeRequest {
    const systemMessages = (openAiBody.messages || []).filter(m => m?.role === 'system');
    const firstSystem = systemMessages[0];
    const firstContent = firstSystem?.content;
    let system: any[];
    if (
        Array.isArray(firstContent) &&
        firstContent[0]?.cache_control &&
        typeof firstContent[0]?.text === 'string'
    ) {
        const stableBlock = firstContent[0];
        const restParts = [
            ...firstContent.slice(1).map(block => blockText([block])),
            ...systemMessages.slice(1).map(m => blockText(m.content)),
        ].filter(Boolean);
        const restText = restParts.join('\n\n');
        system = [
            stableBlock,
            {
                type: 'text',
                text: restText && !restText.startsWith('\n\n') ? `\n\n${restText}` : restText,
            },
        ].filter(block => block.text !== '');
    } else {
        system = [
            {
                type: 'text',
                text: systemMessages.map(m => blockText(m.content)).join('\n\n'),
            },
        ];
    }

    const messages = (openAiBody.messages || [])
        .filter(m => m?.role !== 'system')
        .filter(m => m?.role === 'user' || m?.role === 'assistant')
        .map(m => ({
            role: m.role,
            content: Array.isArray(m.content) ? m.content : String(m.content ?? ''),
        }));

    return {
        url: buildAnthropicMessagesUrl(baseUrl),
        body: {
            model: openAiBody.model,
            max_tokens: openAiBody.max_tokens || 8000,
            temperature: openAiBody.temperature,
            system,
            messages,
        },
    };
}

export function fromClaudeNativeResponse(response: any): any {
    if (!Array.isArray(response?.content)) {
        throw new Error('Claude Native Mode 请求成功，但响应不是 Anthropic /messages 格式：缺少 content[]。请求已停止，没有回退到普通 /chat/completions。');
    }
    const text = Array.isArray(response?.content)
        ? response.content.map((block: any) => {
            if (block?.type === 'text' && typeof block.text === 'string') return block.text;
            return '';
        }).join('')
        : '';
    if (!text.trim()) {
        throw new Error('Claude Native Mode 请求成功，但响应里没有可用文本内容。请求已停止，没有回退到普通 /chat/completions。');
    }
    const inputTokens = typeof response?.usage?.input_tokens === 'number' ? response.usage.input_tokens : undefined;
    const outputTokens = typeof response?.usage?.output_tokens === 'number' ? response.usage.output_tokens : undefined;
    const usage = {
        ...(response?.usage || {}),
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens:
            typeof inputTokens === 'number' && typeof outputTokens === 'number'
                ? inputTokens + outputTokens
                : undefined,
    };

    return {
        id: response?.id,
        model: response?.model,
        usage,
        choices: [
            {
                index: 0,
                finish_reason: response?.stop_reason || null,
                message: {
                    role: 'assistant',
                    content: text,
                },
            },
        ],
        _anthropicNative: response,
    };
}

export function summarizeClaudeNativePayload(input: {
    openAiBody: { messages?: Array<{ role: string; content: any }> };
    nativeBody: ClaudeNativeRequest['body'];
}): ClaudeNativePayloadSummary {
    const shadow = buildClaudeNativeShadowReport(input.openAiBody);
    const openAiMessages = input.openAiBody.messages || [];
    const openAiSystemText = openAiMessages
        .filter(m => m?.role === 'system')
        .map(m => blockText(m.content))
        .join('\n\n')
        .replace(/\r\n/g, '\n');
    const openAiNonSystem = openAiMessages.filter(m => m?.role !== 'system');
    const openAiMessageChars = openAiNonSystem.reduce((sum, m) => sum + normalizeMessageContent(m.content).length, 0);
    const nativeSystemText = (input.nativeBody.system || [])
        .map(block => blockText([block]))
        .join('')
        .replace(/\r\n/g, '\n');
    const nativeSystemChars = nativeSystemText.length;
    const nativeMessageChars = (input.nativeBody.messages || []).reduce((sum, m) => sum + normalizeMessageContent(m.content).length, 0);
    const firstSystemBlock = input.nativeBody.system?.[0];
    const cacheBlockText = typeof firstSystemBlock?.text === 'string' ? firstSystemBlock.text : '';

    return {
        shadowOk: shadow?.ok ?? null,
        actualSystemEqual: openAiSystemText === nativeSystemText,
        actualMessageEqual: openAiMessageChars === nativeMessageChars && openAiNonSystem.length === (input.nativeBody.messages?.length || 0),
        openAiSystemChars: shadow?.systemChars ?? null,
        openAiMessageChars,
        openAiMessageCount: openAiNonSystem.length,
        nativeSystemChars,
        nativeMessageChars,
        nativeMessageCount: input.nativeBody.messages?.length || 0,
        cacheBlockChars: cacheBlockText.length,
        cacheBlockFingerprint: cacheBlockText ? fingerprintText(cacheBlockText) : '',
    };
}

const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export function extractClaudePromptCacheStats(response: unknown): ClaudePromptCacheStats {
    const usage = (response as any)?.usage;
    if (!usage || typeof usage !== 'object') return {};

    const promptDetails = usage.prompt_tokens_details || usage.input_tokens_details || {};
    return {
        cacheCreationInputTokens:
            num(usage.cache_creation_input_tokens) ??
            num(usage.cache_creation_tokens) ??
            num(promptDetails.cache_creation_input_tokens),
        cacheReadInputTokens:
            num(usage.cache_read_input_tokens) ??
            num(usage.cache_read_tokens) ??
            num(promptDetails.cache_read_input_tokens),
        cacheWriteInputTokens:
            num(usage.cache_write_input_tokens) ??
            num(usage.cache_write_tokens) ??
            num(promptDetails.cache_write_input_tokens),
        cachedInputTokens:
            num(promptDetails.cached_tokens) ??
            num(usage.cached_input_tokens),
    };
}

export function formatClaudePromptCacheStats(stats: ClaudePromptCacheStats): string {
    const parts: string[] = [];
    if (stats.cacheCreationInputTokens != null) parts.push(`create=${stats.cacheCreationInputTokens}`);
    if (stats.cacheReadInputTokens != null) parts.push(`read=${stats.cacheReadInputTokens}`);
    if (stats.cacheWriteInputTokens != null) parts.push(`write=${stats.cacheWriteInputTokens}`);
    if (stats.cachedInputTokens != null) parts.push(`cached=${stats.cachedInputTokens}`);
    return parts.length > 0 ? parts.join(' ') : 'no usage cache fields';
}

export function fingerprintText(text: string): string {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
