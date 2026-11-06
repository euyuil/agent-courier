const statuses = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);
const resultFields = ['text', 'content', 'output', 'answers', 'structuredContent', 'isError'];
const maximumResultBytes = 1024 * 1024;

// 仅用于自有合成问题的脱敏观察；标签出现不代表 Agent 已消费答案。
export function summarizeQuestionResult(
  update: Record<string, unknown>, selected: string, unselected: string,
): Record<string, unknown> {
  const source = update['rawOutput'] !== undefined ? 'raw_output'
    : update['content'] !== undefined ? 'content' : 'missing';
  const payload = source === 'raw_output' ? update['rawOutput'] : update['content'];
  const shape = payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload;
  const fields = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? resultFields.filter(field => Object.hasOwn(payload, field)) : [];
  const summary: Record<string, unknown> = {
    status: typeof update['status'] === 'string' && statuses.has(update['status'])
      ? update['status'] : 'other',
    source, shape, fields, bounded: false,
    selectedLabelPresent: null, unselectedLabelPresent: null,
  };
  if (source === 'missing' || payload === null) return summary;
  try {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (serialized === undefined || Buffer.byteLength(serialized) > maximumResultBytes) return summary;
    summary['bounded'] = true;
    summary['selectedLabelPresent'] = selected.length > 0 ? serialized.includes(selected) : null;
    summary['unselectedLabelPresent'] = unselected.length > 0 ? serialized.includes(unselected) : null;
  } catch {
    // 不输出异常文本，其中可能包含私有正文或实现细节。
  }
  return summary;
}
