import { test } from 'node:test';
import * as project from '../../core/src/project.ts';
import { read } from '../../core/src/log.ts';
import { uiHandle } from '../../server/src/server.ts';
import { setup } from './setup.mjs';
import { projectTest } from './project.mjs';

setup();
test('idea to app: new, issues create, queue, loop, adapter contracts', () => projectTest({ uiHandle, read, project }));
