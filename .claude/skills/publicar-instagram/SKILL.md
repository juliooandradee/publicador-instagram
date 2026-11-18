---
name: publicar-instagram
description: Publica e agenda posts no Instagram (foto, carrossel de 2 a 10 imagens e Reels) pelo publicador instalado na pasta publicador-instagram, que usa a API oficial da Meta e o Supabase da própria pessoa. Use quando a pessoa pedir para publicar, agendar, testar sem publicar, remarcar, cancelar ou ver a fila de posts do Instagram, ou quando mandar imagens ou vídeo prontos (do Canva, do Google Drive ou do computador) para postar. Não use para criar a arte nem para escrever a legenda do zero, a não ser que a pessoa peça.
---

# Publicar no Instagram

O publicador fica na pasta `~/publicador-instagram` (se a pessoa instalou em outro lugar, o caminho está no fim deste arquivo). Rode todos os comandos de dentro dela. Quem publica no horário é o Supabase da pessoa: o computador pode estar desligado.

Se a pasta não existir ou `npm run status` disser que falta configurar, siga o `INSTALAR.md` dessa pasta.

## Antes de qualquer publicação

1. `npm run status` mostra o Instagram conectado, o agendador e a fila. Se aparecer "não conectado", rode `npm run conectar -- --instagram @perfil` e espere a pessoa autorizar na tela da Meta.
2. Confirme com a pessoa, numa mensagem só: arquivos na ordem certa, legenda final e horário (fuso do `.env`, padrão Brasília).
3. Nunca publique nem agende sem a pessoa ter dito o horário. "Publica agora" também precisa de um "sim" depois de você mostrar o resumo.

## Comandos

| Pedido | Comando |
|---|---|
| Testar sem publicar | `npm run publicar -- --legenda-arquivo legenda.txt --teste 01.jpg 02.jpg` |
| Agendar | `npm run publicar -- --legenda-arquivo legenda.txt --teste --quando "2026-11-20 09:00" 01.jpg 02.jpg` |
| Publicar agora | `npm run publicar -- --legenda-arquivo legenda.txt --teste --agora foto.jpg` |
| Reels | `npm run publicar -- --legenda-arquivo legenda.txt --teste --quando "..." video.mp4` |
| Ver a fila | `npm run fila` |
| Mudar o horário | `npm run agendar -- <id> --quando "2026-11-21 18:30"` |
| Cancelar | `npm run cancelar -- <id>` |
| Conferir a conexão | `npm run conferir` |

- 1 imagem vira foto; de 2 a 10 imagens, carrossel na ordem em que os arquivos aparecem no comando; 1 vídeo vira Reels.
- Legenda com mais de uma linha, emoji ou aspas: grave num arquivo `.txt` e use `--legenda-arquivo`. Limites: 2.200 caracteres, 30 hashtags, 20 marcações.
- O `<id>` aceita os 8 primeiros caracteres mostrados no `npm run fila`.
- Sempre use `--teste` junto com o agendamento: ele pede ao Instagram para montar o post e só depois agenda. Leia a linha "Teste: ..." para a pessoa.
- Horário aceita `2026-11-20 09:00`, `20/11/2026 09:00` ou `20/11 9h30`. "Amanhã às 9h" você converte para a data antes de rodar.

## Imagens e vídeos

- Feed aceita de 4:5 (1080 × 1350, vertical) a 1,91:1 (horizontal). Carrossel corta todas pela proporção da primeira: prefira todas iguais.
- JPEG vai direto; PNG, WebP e HEIC são convertidos sozinhos (sips no Mac ou ffmpeg).
- Reels: MP4 com H.264 e AAC, vertical, de 3 s a 15 min, até 50 MB (limite do Supabase grátis). Passou disso, use `--comprimir` (precisa do ffmpeg).
- Canva ou Google Drive: se o conector estiver ligado na sua conta, baixe as imagens para uma pasta temporária nova (por exemplo `/tmp/publicar-instagram/<nome>/`), numeradas na ordem, e passe os caminhos. Apague a pasta no fim.

## Depois de rodar

Responda em até 3 linhas: o que foi criado (tipo e número de imagens), o resultado do teste e quando sai (data e hora no fuso da pessoa) ou o link, se já saiu. Erros vêm em português e dizem o que fazer: repasse sem rodar de novo às cegas. Se o comando disser que o Instagram pode já ter recebido o post, peça para a pessoa conferir o perfil antes de qualquer nova tentativa.

## Regras

- Nunca mostre, copie nem peça o conteúdo do `.env` (a chave secreta do Supabase e o app da Meta). Nunca peça a senha do Instagram ou do Facebook: a conexão é sempre pela tela oficial da Meta.
- As imagens de `exemplos/` são só para teste. Depois de testar com elas, cancele o post (`npm run cancelar -- <id>`).
- Para desconectar (`npm run desconectar -- --sim`), só com pedido explícito da pessoa.

Pasta do publicador: ~/publicador-instagram
