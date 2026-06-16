/**
 * Memory Palace — 导出
 *
 * 把某个角色（或全部角色）的记忆宫殿数据打包成可读 + 可机读的 JSON，
 * 方便用户接入自己的外置记忆库。
 *
 * 导出内容：记忆节点（content/room/importance/mood/tags/时间…）、事件盒、期盼。
 * **不含向量**：向量是跟 embedding 模型强绑定的二进制（1024 维 float），
 * 换模型就失效、且体积巨大，对外置库无意义——需要时在目标侧重新向量化即可。
 */

import { MemoryNodeDB, AnticipationDB, EventBoxDB } from './db';
import type { MemoryNode, Anticipation, EventBox } from './types';
import { getRoomLabel } from './types';

/** 单个角色的导出结构 */
export interface CharacterMemoryPalaceExport {
    charId: string;
    charName: string;
    counts: { nodes: number; eventBoxes: number; anticipations: number };
    nodes: MemoryNode[];
    eventBoxes: EventBox[];
    anticipations: Anticipation[];
}

/** 顶层导出文件结构 */
export interface MemoryPalaceExportFile {
    type: 'sully_memory_palace_export';
    version: 1;
    exportedAt: number;
    exportedAtISO: string;
    /** 向量未导出的说明，提醒接入方需自行重新向量化 */
    note: string;
    characters: CharacterMemoryPalaceExport[];
}

const EXPORT_NOTE =
    '本文件不含向量数据（向量与 embedding 模型强绑定，对外置记忆库无意义，需在目标侧重新向量化）。' +
    'nodes 即每一条记忆，content 为正文；room 为所属房间，含义见 roomLabel；eventBoxes 为事件盒（summaryNodeId 指向整合回忆节点）。';

/** 收集单个角色的记忆宫殿数据 */
async function collectCharacter(charId: string, charName: string): Promise<CharacterMemoryPalaceExport> {
    const [nodes, eventBoxes, anticipations] = await Promise.all([
        MemoryNodeDB.getByCharId(charId),
        EventBoxDB.getByCharId(charId),
        AnticipationDB.getByCharId(charId),
    ]);
    // 给每条记忆补一个人类可读的房间名，外置库无需自己映射枚举
    const enrichedNodes = nodes.map(n => ({ ...n, roomLabel: getRoomLabel(n.room) }));
    return {
        charId,
        charName,
        counts: { nodes: nodes.length, eventBoxes: eventBoxes.length, anticipations: anticipations.length },
        nodes: enrichedNodes as MemoryNode[],
        eventBoxes,
        anticipations,
    };
}

/** 导出一个或多个角色的记忆宫殿数据为 JSON 文件结构 */
export async function exportMemoryPalace(
    chars: { id: string; name: string }[],
): Promise<MemoryPalaceExportFile> {
    const characters: CharacterMemoryPalaceExport[] = [];
    for (const c of chars) {
        characters.push(await collectCharacter(c.id, c.name));
    }
    const now = Date.now();
    return {
        type: 'sully_memory_palace_export',
        version: 1,
        exportedAt: now,
        exportedAtISO: new Date(now).toISOString(),
        note: EXPORT_NOTE,
        characters,
    };
}
