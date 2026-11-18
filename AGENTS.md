# Publicador de Instagram: instruções para o agente

Projeto que publica foto, carrossel e Reels no Instagram, no horário marcado, pela API oficial da Meta. Roda no Supabase da própria pessoa (banco, cofre, armazenamento, agendador e uma função), e a pessoa usa pelo Claude Code ou pelo Codex.

## O que fazer

- **Instalar ou reinstalar:** siga o [INSTALAR.md](INSTALAR.md) do começo ao fim.
- **Publicar, agendar, testar, cancelar ou ver a fila:** siga a skill `publicar-instagram` (`.agents/skills/publicar-instagram/SKILL.md` no Codex, `.claude/skills/publicar-instagram/SKILL.md` no Claude Code; as duas são iguais).
- **Ajuda dos comandos:** `npm run ajuda`.

## Regras que valem sempre

- Nunca peça a senha do Instagram ou do Facebook; a conexão é pela tela oficial da Meta (`npm run conectar`).
- Nunca mostre, copie nem envie o conteúdo do `.env`. Ele nunca vai para o Git.
- Nunca publique nem agende sem a pessoa dizer o horário e confirmar o conteúdo. Teste primeiro (`--teste`).
- Erros dos comandos saem em português e dizem o que fazer. Repasse; não repita a publicação às cegas.

## Como o código está organizado

- `supabase/migrations/`: banco (tabelas no esquema privado `instagram_publisher`, funções `public.instagram_publisher_*` só para a chave secreta, bucket privado, cofre e agendador pg_cron).
- `supabase/functions/publicador/`: a função única (volta da Meta, agendador e comandos). A lógica fica em `supabase/functions/_shared/`.
- `src/` e `bin/`: a linha de comando (`npm run ...`), sem dependências.
- `tests/`: `npm test` (Node 22+) e `npm run test:banco` (Postgres local, opcional).

Antes de mudar código: `npm test` e, se mexer na função, `deno check supabase/functions/publicador/index.ts`. Depois de mudar a função ou a migração, publique com `npm run supabase:instalar`.
