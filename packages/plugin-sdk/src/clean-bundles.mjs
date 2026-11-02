import {rmSync} from 'node:fs';
import {join} from 'node:path';

rmSync(join(import.meta.dirname, '..', 'node_modules'), {recursive: true, force: true});
