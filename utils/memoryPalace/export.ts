/**
 * Memory Palace — 导出
 *
 * 把某个角色（或全部角色）的记忆宫殿数据打包成可读 + 可机读的 JSON，
 * 方便用户接入自己的外置记忆库。
 *
 * 导出内容：记忆节点（content/room/importance/mood/tags/时间…）、事件盒、期盼。
 *
 * 向量（includeVectors）：可选。
 *   - 关掉：文件小，但目标侧需自行重新向量化。
 *   - 打开：连 embedding 向量一起导出。**只要继续用同一个 embedding 模型 +
 *     维度**，向量可直接复用，省掉重新向量化的钱和时间、检索结果完全一致；
 *     换了模型则向量作废（vector.model / dimensions 已随每条一起导出，便于核对）。
 */

import { MemoryNodeDB, AnticipationDB, EventBoxDB, MemoryVectorDB } from './db';
import type { MemoryNode, Anticipation, EventBox } from './types';
import { getRoomLabel } from './types';

/** 导出时随向量一起带上的元信息（便于接入方判断能否复用） */
export interface ExportedVector {
    memoryId: string;
    /** 普通 number[]，长度 = dimensions */
    vector: number[];
    dimensions: number;
    /** 生成该向量的 embedding 模型；与目标侧模型一致才可直接复用 */
    model?: string;
}

/** 单个角色的导出结构 */
export interface CharacterMemoryPalaceExport {
    charId: string;
    charName: string;
    counts: { nodes: number; eventBoxes: number; anticipations: number; vectors: number };
    /** 该角色向量统一用的 embedding 模型/维度（多数情况下整库一致，便于接入方一眼确认） */
    embeddingModels: string[];
    nodes: MemoryNode[];
    eventBoxes: EventBox[];
    anticipations: Anticipation[];
    /** includeVectors=false 时为 undefined */
    vectors?: ExportedVector[];
}

/** 顶层导出文件结构 */
export interface MemoryPalaceExportFile {
    type: 'sully_memory_palace_export';
    version: 1;
    exportedAt: number;
    exportedAtISO: string;
    includeVectors: boolean;
    note: string;
    characters: CharacterMemoryPalaceExport[];
}

const NOTE_WITH_VECTORS =
    'nodes 即每一条记忆，content 为正文，room 为所属房间（含义见 roomLabel）；eventBoxes 为事件盒（summaryNodeId 指向整合回忆节点）。' +
    'vectors 为 embedding 向量，按 memoryId 与 nodes 对应：只要接入方继续用同一个 embedding 模型 + 维度即可直接复用，无需重新向量化；换模型则向量作废（每条带 model/dimensions 便于核对）。';

const NOTE_NO_VECTORS =
    'nodes 即每一条记忆，content 为正文，room 为所属房间（含义见 roomLabel）；eventBoxes 为事件盒（summaryNodeId 指向整合回忆节点）。' +
    '本次未导出向量（仅文本结构），接入方需要语义检索时请在目标侧自行重新向量化。';

/** 收集单个角色的记忆宫殿数据 */
async function collectCharacter(
    charId: string,
    charName: string,
    includeVectors: boolean,
): Promise<CharacterMemoryPalaceExport> {
    const [nodes, eventBoxes, anticipations] = await Promise.all([
        MemoryNodeDB.getByCharId(charId),
        EventBoxDB.getByCharId(charId),
        AnticipationDB.getByCharId(charId),
    ]);

    let vectors: ExportedVector[] | undefined;
    const modelSet = new Set<string>();
    if (includeVectors) {
        // getAllByCharId 出 DB 层后向量一律是 Float32Array，转成普通 number[] 才能进 JSON
        const raw = await MemoryVectorDB.getAllByCharId(charId);
        vectors = raw.map(v => {
            if (v.model) modelSet.add(`${v.model}@${v.dimensions}d`);
            return {
                memoryId: v.memoryId,
                vector: Array.from(v.vector as Float32Array),
                dimensions: v.dimensions,
                model: v.model,
            };
        });
    }

    // 给每条记忆补一个人类可读的房间名，外置库无需自己映射枚举
    const enrichedNodes = nodes.map(n => ({ ...n, roomLabel: getRoomLabel(n.room) }));
    return {
        charId,
        charName,
        counts: {
            nodes: nodes.length,
            eventBoxes: eventBoxes.length,
            anticipations: anticipations.length,
            vectors: vectors?.length ?? 0,
        },
        embeddingModels: [...modelSet],
        nodes: enrichedNodes as MemoryNode[],
        eventBoxes,
        anticipations,
        vectors,
    };
}

/** 导出一个或多个角色的记忆宫殿数据为 JSON 文件结构 */
export async function exportMemoryPalace(
    chars: { id: string; name: string }[],
    options: { includeVectors?: boolean } = {},
): Promise<MemoryPalaceExportFile> {
    const includeVectors = options.includeVectors ?? false;
    const characters: CharacterMemoryPalaceExport[] = [];
    for (const c of chars) {
        characters.push(await collectCharacter(c.id, c.name, includeVectors));
    }
    const now = Date.now();
    return {
        type: 'sully_memory_palace_export',
        version: 1,
        exportedAt: now,
        exportedAtISO: new Date(now).toISOString(),
        includeVectors,
        note: includeVectors ? NOTE_WITH_VECTORS : NOTE_NO_VECTORS,
        characters,
    };
}
