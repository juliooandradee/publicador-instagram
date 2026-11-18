#!/usr/bin/env node
// Publicador de Instagram. Ajuda: npm run ajuda
import { main } from '../src/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
