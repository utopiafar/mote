import { reportStartFailure,startServer } from './start-server.js';

// This module is the executable Central entry, so evaluating it starts one
// node. Trusted in-process hosts import startServer from start-server.js.
void startServer().catch(reportStartFailure);
