CREATE TABLE harness_events (
  id TEXT PRIMARY KEY, bindingId TEXT NOT NULL REFERENCES harness_bindings(id), runId TEXT NOT NULL REFERENCES runs(id),
  sourceEventKey TEXT NOT NULL, eventType TEXT NOT NULL, sequence INTEGER, payloadRef TEXT NOT NULL REFERENCES private_content(id),
  processedAt INTEGER NOT NULL, UNIQUE(bindingId,sourceEventKey)
) STRICT;
CREATE TABLE output_messages (
  id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id), sourceMessageId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('progress','final','question','permission_request','error','message','tool_status','artifact')),
  userVisible INTEGER NOT NULL CHECK (userVisible IN (0,1)), logicalSequence INTEGER NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('assembling','complete','invalid')),
  selected INTEGER NOT NULL CHECK (selected IN (0,1)), hiddenReason TEXT, contentRef TEXT NOT NULL REFERENCES private_content(id),
  finalFragmentIndex INTEGER,
  UNIQUE(runId,sourceMessageId), UNIQUE(runId,logicalSequence)
) STRICT;
CREATE TABLE output_fragments (
  id TEXT PRIMARY KEY, outputMessageId TEXT NOT NULL REFERENCES output_messages(id), sourceFragmentKey TEXT NOT NULL,
  fragmentIndex INTEGER NOT NULL CHECK (fragmentIndex>=0), textRef TEXT NOT NULL REFERENCES private_content(id),
  UNIQUE(outputMessageId,sourceFragmentKey), UNIQUE(outputMessageId,fragmentIndex)
) STRICT;
