// Pure session-file integrity check. Returns an array of warning strings;
// callers decide how to surface them (debug log, piUI, diagDump, etc.).
// Extracted from index.ts so tests can import without activating the extension.

import { statSync, readFileSync } from "fs";

/** Normalize a caught value to a message: `catch` bindings are `unknown` under
 *  strict mode. */
function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function verifyWrittenSession(jsonlPath: string, expectedSessionId: string, expectedRecordCount: number): string[] {
	const warnings = [];
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(jsonlPath);
	} catch (e) {
		warnings.push(`file missing after save — path=${jsonlPath} err=${errText(e)}`);
		return warnings;
	}
	let content: string;
	try {
		content = readFileSync(jsonlPath, "utf8");
	} catch (e) {
		warnings.push(`file unreadable — path=${jsonlPath} size=${st.size} err=${errText(e)}`);
		return warnings;
	}
	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length !== expectedRecordCount) {
		warnings.push(`record count mismatch — expected=${expectedRecordCount} actual=${lines.length} path=${jsonlPath} bytes=${content.length}`);
		return warnings;
	}
	try {
		const firstRec = JSON.parse(lines[0]);
		const lastRec = JSON.parse(lines[lines.length - 1]);
		if (firstRec.sessionId !== expectedSessionId || lastRec.sessionId !== expectedSessionId) {
			warnings.push(`sessionId drift — expected=${expectedSessionId} first=${firstRec.sessionId} last=${lastRec.sessionId}`);
		}
	} catch (e) {
		warnings.push(`malformed JSONL — path=${jsonlPath} err=${errText(e)}`);
	}
	return warnings;
}
