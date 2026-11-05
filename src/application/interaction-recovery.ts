import type { Connection } from '../storage/database.js';
export function recoverInteractions(db:Connection):void {
  db.prepare("UPDATE pending_inputs SET answerStatus='unknown',revision=revision+1 WHERE answerStatus='dispatching'").run();
}
