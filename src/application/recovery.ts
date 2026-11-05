import type { Connection } from '../storage/database.js';
import { transaction } from '../storage/database.js';
import { recoverInteractions } from './interaction-recovery.js';
export function recover(db:Connection):void {
  transaction(db,()=>{
    db.prepare("UPDATE harness_operations SET status='unknown',resultCode='state_unknown' WHERE status='dispatching'").run();
    db.prepare("UPDATE inputs SET status='unknown',errorCode='state_unknown' WHERE status='dispatching'").run();
    db.prepare("UPDATE inputs SET status='rejected',errorCode='recovery_interrupted' WHERE status='received'").run();
    db.prepare("UPDATE harness_bindings SET status='unknown',revision=revision+1 WHERE status='creating'").run();
    db.prepare("UPDATE runs SET status='unknown',revision=revision+1 WHERE status IN ('submitting','running','waiting_input')").run();
    db.prepare("UPDATE outbound_deliveries SET status='unknown',errorCode='state_unknown' WHERE status='sending'").run();
    db.prepare("UPDATE delivery_attempts SET outcome='unknown' WHERE outcome='sending'").run();
    recoverInteractions(db);
  });
}
