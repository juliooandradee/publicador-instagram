# Publicador de Instagram

Publique foto, carrossel e Reels no seu Instagram **no horário que você escolher**, pela **API oficial da Meta**, sem ferramenta paga e sem deixar o computador ligado. Você pede ao Claude Code ou ao Codex ("publica estas 5 imagens amanhã às 9h") e o seu próprio Supabase publica na hora certa.

- Foto única, carrossel de 2 a 10 imagens e Reels.
- "Testar sem publicar": o Instagram monta o post e confirma que aceitou, sem publicar.
- Agendamento até 120 dias à frente, no seu fuso.
- Nunca publica duas vezes: cada etapa fica registrada antes da próxima chamada à Meta.
- A chave do Instagram fica no cofre (Vault) do seu Supabase. Ninguém pede sua senha do Instagram ou do Facebook.

## Como funciona

```
Você (Claude Code ou Codex)          Seu Supabase (grátis)                          Meta
  npm run publicar ...  ───────►  bucket privado (imagens e vídeos)
                                  fila de posts + cofre (chave do Instagram)
                                  agendador: confere a fila a cada minuto  ───►  monta o post
                                  função "publicador"                       ───►  publica no horário
                                                                            ◄───  link do post
```

## Instalar copiando e colando

Abra o **Claude Code** ou o **Codex** na sua pasta de usuário e cole:

```text
Quero instalar o Publicador de Instagram no meu computador.

1. Baixe o projeto para a pasta publicador-instagram, dentro da minha pasta de usuário:
   git clone https://github.com/juliooandradee/publicador-instagram
   (se a pasta já existir, entre nela e rode git pull).
2. Abra o arquivo INSTALAR.md dessa pasta e siga do começo ao fim, na ordem.
3. Faça você tudo o que der pelo terminal. Quando precisar de mim (entrar no Supabase,
   criar o app na Meta, autorizar o Instagram), me diga exatamente onde clicar e espere.
4. Nunca me peça a senha do Instagram ou do Facebook. As chaves eu colo no arquivo .env,
   não aqui no chat.
5. Não publique nada de verdade sem eu dizer o horário. O primeiro teste é sem publicar.

Meu Instagram: @
```

Você vai precisar de: Instagram **profissional** ligado a uma **Página do Facebook** que você administra, uma conta grátis no [Supabase](https://supabase.com) e uma conta de desenvolvedor na [Meta](https://developers.facebook.com) (a mesma do seu Facebook). A instalação leva de 20 a 40 minutos; a maior parte é a criação do app na Meta, que o agente explica clique por clique.

## No dia a dia

Peça em português:

- "Publica estas 5 imagens amanhã às 9h com esta legenda."
- "Agenda este Reels para sexta às 18h30."
- "Testa este carrossel sem publicar."
- "Mostra a fila." / "Cancela o post de quinta."

Ou rode você mesmo, dentro da pasta:

```bash
npm run publicar -- --legenda-arquivo legenda.txt --teste --quando "2026-11-20 09:00" 01.jpg 02.jpg 03.jpg
npm run fila
npm run ajuda
```

## Custos e limites

- **Supabase:** cabe no plano grátis (banco, armazenamento de 1 GB, funções e agendador). As mídias são apagadas do armazenamento depois que o post sai.
- **Meta:** a API é gratuita. Limite de 100 publicações por 24 horas por perfil.
- **Arquivos:** imagens JPEG, PNG, WebP ou HEIC, de 4:5 a 1,91:1, até 8 MB. Reels em MP4 (H.264 e AAC) de 3 s a 15 min, até 50 MB no plano grátis (`--comprimir` reduz).
- **App da Meta em modo de desenvolvimento:** basta para publicar em perfis que você mesmo administra. Para publicar no perfil de outras pessoas ou clientes, a Meta exige análise do app e verificação da empresa; isso fica fora deste projeto.
- Carrossel com vídeo, Stories e marcação de pessoas ainda não estão incluídos.

## Segurança

- A chave do Instagram e a chave secreta do app da Meta ficam no **Vault** do seu Supabase. O arquivo `.env` (que nunca vai para o Git) guarda só a chave secreta do Supabase.
- As tabelas ficam num esquema privado, fora da API pública, e só a chave secreta do projeto chama as funções do publicador.
- A Meta busca cada imagem por um link assinado que vale 1 hora, num bucket privado.
- Para desfazer: `npm run desconectar -- --sim` e, no Facebook, remova o app em **Integrações comerciais**.

## O que foi testado

- Testes automáticos da função, da conexão, da linha de comando e da instalação (`npm test`) e do banco num Postgres local (`npm run test:banco`).
- Num projeto novo do Supabase: a migração, a função publicada, o agendador acordando a função, o link assinado da imagem, a chamada à Meta de verdade e as respostas de erro.
- A conexão pela Página, o carrossel e o Reels seguem o mesmo caminho que já publica num perfil real. A instalação completa com um app novo da Meta, do zero, ainda não foi feita com este pacote: se algum menu da Meta estiver diferente, o agente procura pelo nome da permissão.

## Para quem quer mexer no código

```bash
npm test                 # Node 22+, sem dependências
npm run test:banco       # precisa do Postgres 15+ local (macOS: brew install postgresql@16)
deno check supabase/functions/publicador/index.ts
```

Estrutura: `supabase/migrations/` (banco), `supabase/functions/` (função única), `src/` e `bin/` (linha de comando), `.claude/skills/` e `.agents/skills/` (a mesma skill para Claude Code e Codex), `INSTALAR.md` (roteiro que o agente segue).

Licença MIT.
