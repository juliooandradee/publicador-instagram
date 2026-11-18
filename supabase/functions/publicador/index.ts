// Ponto de entrada no Supabase (Deno). A lógica fica em handler.mjs, testada no Node.
import { makeHandler } from './handler.mjs';

Deno.serve(makeHandler({ env: Deno.env.toObject() }));
