import type { ErrorCode } from '../domain/errors.js';

const reasons: Record<ErrorCode, string> = {
  unconfigured: '未配置目标 Harness。请检查指定实例配置。',
  auth_required: 'Harness 登录已失效。请通过官方流程恢复登录后核实原任务。',
  resume_unsupported: '原 Harness 会话不可续接。请检查原目标的续接能力。',
  session_missing: '原 Harness 会话不可用。请核实原会话，未创建替代会话。',
  writer_occupied: '原 Harness 会话写入权被占用。请与持有写入权的客户端协调交接。',
  capability_unverified: '所需能力缺少有效验证证据。请完成对应能力验证。',
  steer_unsupported: '目标不支持在当前任务内及时处理补充输入。请检查 Harness 能力。',
  steer_rejected: '本次补充被明确拒绝。请核实原任务状态。',
  stale_run: '原任务已结束或关联失效。本次输入未转为新任务。',
  request_invalid: '答复关联、格式或选项无效。请使用原私聊中的有效请求编号和选项。',
  interaction_blocked: '人工交互暂时不可用。请核实原请求，系统未代答或批准。',
  output_unsupported: '输出类型或消息边界无法核实。请检查 Harness 输出能力。',
  state_unknown: '结果尚无法确认，未再次提交。请核实原操作或投递。',
  configuration_invalid: '配置无效。请检查配置结构和引用，保留原有效配置。',
  storage_unavailable: '本地状态存储不可用。请恢复原状态库，不要删除后重建。',
  instance_locked: '状态库正在被其他 Courier 工作进程使用。请先停止该进程。',
  recovery_interrupted: '该输入在恢复前未派发，本次不会自动执行。请核实后发送新消息。',
  protocol_conflict: '收到相互冲突的协议证据。相关新操作已停止，请核实原状态。',
  input_unsupported: '首版仅支持非空文本私聊。请发送文字消息。',
  route_unavailable: '原私聊没有已验证的可用发送路径。是否通知用户尚无法确认。',
  text_too_long: '本条内容超过已验证的单条长度限制，未截断发送。请调整输出形式。',
  delivery_failed: '部分内容未能投递，自动尝试已停止。请查看本地投递状态。',
  content_missing: '任务已结束，但没有取得应有的完整最终回答。请核实原任务输出。',
  run_failed: 'Agent 的原任务已明确执行失败，已收到的内容保留。请核实原任务失败原因。',
};
export function diagnostic(code: ErrorCode, fact: 'not_submitted' | 'accepted' | 'unknown' = 'unknown') {
  return { code, fact, message: reasons[code] };
}
export interface SafeLog { code: ErrorCode; localId?: string }
export function safeLog(code: ErrorCode, localId?: string): SafeLog {
  return localId === undefined ? { code } : { code, localId };
}
export function exportAliases(value: SafeLog[]): SafeLog[] {
  const ids = new Map<string, string>();
  return value.map(item => {
    if (!item.localId) return { code: item.code };
    if (!ids.has(item.localId)) ids.set(item.localId, `local-${ids.size + 1}`);
    return { code: item.code, localId: ids.get(item.localId)! };
  });
}
