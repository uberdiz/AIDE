import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConversationStore, type Conversation } from '../../src/chat/conversations';

/** Branch through a throwaway store (the store persists conversations to disk). */
export function branchTurns(src: Conversation, upto: number): Conversation {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-conv-'));
	try {
		return new ConversationStore(dir).branch(src, upto);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
