/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'fs';
import * as path from 'path';

// Mocked Pattern logic from ChangeManager
function parsePatches(response: string) {
    const changes: any[] = [];
    const fileBlockPattern = /\[FILE:\s*([a-zA-Z0-9_\-\./]+)\]\s*```[a-z]*\n([\s\S]*?)```/gi;
    let match;
    while ((match = fileBlockPattern.exec(response)) !== null) {
        changes.push({ path: match[1], content: match[2] });
    }

    if (changes.length === 0) {
        const lines = response.split('\n');
        const firstLine = lines[0].trim();
        const filePathMatch = firstLine.match(/\/\/\s*([a-zA-Z0-9_\-\./]+)|#\s*([a-zA-Z0-9_\-\./]+)/);
        if (filePathMatch) {
            const path = filePathMatch[1] || filePathMatch[2];
            let cleanContent = response.replace(firstLine, '').trim();
            cleanContent = cleanContent.replace(/^```[a-z]*\n/i, '').replace(/\n```$/i, '');
            changes.push({ path, content: cleanContent });
        }
    }
    return changes;
}

const testResponse = `
[FILE: test_file.ts]
\`\`\`typescript
export const test = 1;
\`\`\`
`;

const testResponse2 = `// test_file_direct.ts
\`\`\`typescript
console.log("direct apply works");
\`\`\`
`;

console.log("--- TEST 1: Standard Block ---");
const p1 = parsePatches(testResponse);
console.log(JSON.stringify(p1, null, 2));

console.log("\n--- TEST 2: Direct Comment Block ---");
const p2 = parsePatches(testResponse2);
console.log(JSON.stringify(p2, null, 2));

if (p1.length > 0 && p2.length > 0) {
    console.log("\n✅ PATCH PARSING VERIFIED");
} else {
    console.log("\n❌ PATCH PARSING FAILED");
    process.exit(1);
}
