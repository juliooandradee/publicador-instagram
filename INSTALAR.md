# Instalar o Publicador de Instagram

Roteiro para o Claude Code ou o Codex. Siga na ordem, um passo por vez. Fale com a pessoa em português simples: diga o que vai fazer, faça e conte o resultado em uma ou duas linhas.

Ao final, a pessoa terá um publicador próprio: ela manda as imagens ou o vídeo e a legenda, e o post sai sozinho no horário, pela API oficial da Meta, mesmo com o computador desligado.

## Regras durante a instalação

- **Faça você tudo o que der pelo terminal.** Peça ajuda à pessoa só no que exige ela: entrar no Supabase, criar o app na Meta, autorizar o Instagram.
- **Nunca peça a senha do Instagram nem a do Facebook.** A conexão é sempre pela tela oficial da Meta.
- **Segredos ficam no arquivo `.env`, não no chat.** Os comandos deste projeto gravam a chave do Supabase sem mostrá-la. A chave secreta do app da Meta a própria pessoa cola no `.env`. Se ela colar no chat mesmo assim, use só para gravar no `.env` e não repita.
- **Nada é publicado de verdade sem a pessoa dizer o horário.** Os testes usam "testar sem publicar".
- Os comandos `npm run ...` rodam **dentro da pasta do publicador**.
- No Codex, comandos que usam a internet podem pedir aprovação. Explique à pessoa que é para baixar a CLI do Supabase e falar com o Supabase e a Meta.

## 0. Conferir o computador

1. `node -v` precisa mostrar 22 ou mais. Se faltar: no Mac, `brew install node` (sem Homebrew, peça para instalar a versão LTS em https://nodejs.org); no Windows, o instalador LTS de https://nodejs.org. Feche e abra o terminal depois.
2. `git --version`. Se faltar: no Mac, `xcode-select --install`; no Windows, https://git-scm.com.
3. Se você está lendo isto, o repositório já está na pasta `publicador-instagram`. Entre nela e rode `npm test`: precisa terminar com `# fail 0`. Não há pacotes para instalar (o projeto não tem dependências).

## 1. Supabase: o servidor grátis que publica no horário

1. Pergunte se a pessoa já tem conta em https://supabase.com. Se não tiver, peça para criar (pode entrar com o GitHub ou com e-mail) e escolher o plano **Free**.
2. `npm run preparar` cria o `.env` e uma senha forte para o banco.
3. `npx supabase@3.2.0 login` abre o navegador. A pessoa entra e autoriza. Se o terminal mostrar um código de verificação, mostre o código para ela digitar.
4. `npx supabase@3.2.0 orgs list` lista as organizações. Se houver uma só, use. Se houver várias, pergunte qual. Se não houver nenhuma, peça para a pessoa criar em https://supabase.com/dashboard.
5. `npm run supabase:projeto -- --org <id da organização>` cria o projeto `publicador-instagram` em São Paulo e liga a pasta a ele. Leva uns 2 minutos.
   - O plano grátis permite 2 projetos ativos por organização. Se o Supabase recusar por limite, explique e pergunte se a pessoa prefere pausar um projeto antigo no painel ou usar um que já existe. Para usar um existente: `npm run supabase:projeto -- --ref <id do projeto>`, com a senha do banco desse projeto na linha `SUPABASE_DB_PASSWORD` do `.env` (a pessoa pode criar uma nova em Project Settings → Database → Reset database password).
6. `npm run supabase:instalar` aplica o banco (tabelas, cofre, bucket privado e agendador), publica a função `publicador` e grava a chave secreta no `.env`.
   - Se ele disser que não achou a chave secreta: peça para a pessoa abrir Project Settings → API Keys → Secret keys, copiar a chave que começa com `sb_secret_` e colar no `.env`, na linha `SUPABASE_SECRET_KEY`.
7. `npm run configurar` liga o agendador e mostra o **endereço de retorno**, no formato `https://<id-do-projeto>.supabase.co/functions/v1/publicador`. Guarde: ele vai no passo 2.4.
8. `npm run status` precisa mostrar "Agendador: ativo".

## 2. App da Meta: a pessoa faz no navegador, você guia

Antes, confira com a pessoa:

- O Instagram é **profissional** (Empresa ou Criador de conteúdo) e está **ligado a uma Página do Facebook**. No app do Instagram: Editar perfil → Página. Sem esse vínculo a Meta não mostra o Instagram.
- Ela **administra essa Página** com o mesmo Facebook que vai usar para criar o app.

Abra https://developers.facebook.com/apps para ela e guie, um item por vez. Os nomes dos menus mudam de vez em quando; se um rótulo não bater, procure pelo nome da permissão ou do login.

1. **Criar o app.** "Criar app" → nome livre (por exemplo, "Meu publicador") → caso de uso **Gerenciar mensagens e conteúdo no Instagram**. Se a Meta pedir um portfólio empresarial, pode vincular o da pessoa ou seguir sem. O app pode ficar em **modo de desenvolvimento**: basta para publicar em contas que a própria pessoa administra.
2. **Escolher o login do Facebook.** No caso de uso, escolha a configuração da API **com login do Facebook** (não a do login do Instagram). Adicione as cinco permissões: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` e `business_management`.
3. **Criar a configuração de login.** Em **Login do Facebook para Empresas → Configurações**, crie uma configuração com **token de acesso do usuário** (não escolha usuário do sistema), marque as cinco permissões e salve. Anote o **ID da configuração** (só números).
4. **Endereço de retorno.** Na mesma área de configurações do login, em **URIs de redirecionamento do OAuth válidos**, cole o endereço do passo 1.7, igualzinho, e salve.
5. **ID e chave secreta.** Em **Configurações do app → Básico** ficam o **ID do app** e a **Chave secreta do app** (clicar em "Mostrar" pede a senha do Facebook, que fica só com a pessoa).

Agora abra o `.env` para a pessoa preencher (Mac: `open -e .env`; Windows: `notepad .env`; Linux: `xdg-open .env`) nas linhas `META_APP_ID`, `META_APP_SECRET` e `META_CONFIG_ID`. Peça para salvar e avisar. Depois:

- `npm run configurar` confere o ID e a chave secreta com a própria Meta, guarda tudo no cofre do Supabase e apaga a chave secreta do `.env`. Precisa terminar com "O app da Meta foi conferido...".

## 3. Conectar o Instagram

1. `npm run conectar -- --instagram @perfil` (o @ que a pessoa quer usar). Ele abre a tela oficial da Meta e espera até 90 segundos.
2. Na Meta, a pessoa entra com o Facebook que administra a Página, escolhe **a Página e o Instagram** (pode marcar "todas as atuais e futuras") e salva. A Meta pode pedir um código por SMS: o pedido vale 30 minutos.
3. A janela mostra "Pronto! O Instagram @... está conectado". O comando confirma sozinho; se o tempo acabar antes, rode `npm run status`.
4. `npm run conferir` pergunta à Meta pelo @, pelo número de posts e pela cota de publicações do dia (100 por 24 horas).

Se a janela mostrar outra mensagem, ela já diz o que fazer. As mais comuns estão em "Se travar", no fim.

## 4. Testar sem publicar

1. `npm run publicar -- --legenda "Teste do publicador" --teste exemplos/teste-1.jpg exemplos/teste-2.jpg`
2. Precisa aparecer: "Teste: O Instagram de @... aceitou as 2 imagens e a legenda. Nada foi publicado."
3. Cancele o rascunho de teste: `npm run cancelar -- <id>` (o id aparece na linha "Post criado").
4. Se a pessoa for usar Reels: `npm run publicar -- --legenda "Teste de Reels" --teste exemplos/teste-reels.mp4`, espere "aceitou o vídeo" e cancele também.

## 5. Primeiro post de verdade

Peça à pessoa as imagens (ou o vídeo), a legenda e o horário. Mostre o resumo, espere o "sim" e agende com pelo menos 5 minutos de antecedência:

`npm run publicar -- --legenda-arquivo legenda.txt --teste --quando "AAAA-MM-DD HH:MM" 01.jpg 02.jpg 03.jpg`

Depois do horário, `npm run fila` mostra o link. Peça para a pessoa abrir o link numa janela anônima: se o post aparecer, está tudo certo. Se não aparecer para quem não está logado, o app talvez precise sair do modo de desenvolvimento (aí valem a análise do app e a verificação da empresa pela Meta); avise a pessoa antes de agendar outros.

## 6. Deixar pronto para o dia a dia

Para a pessoa poder pedir "publica isso amanhã às 9h" de qualquer pasta, instale a skill no nível do usuário:

- **Claude Code:** copie `.claude/skills/publicar-instagram/` para `~/.claude/skills/publicar-instagram/`.
- **Codex:** copie `.agents/skills/publicar-instagram/` para `~/.agents/skills/publicar-instagram/`.
- Se a pasta do publicador não for `~/publicador-instagram`, troque o caminho na última linha do `SKILL.md` copiado.
- Se já existir uma skill com esse nome, mostre a diferença e pergunte antes de substituir.

Termine contando à pessoa, em até 3 linhas, o que ficou pronto e exemplos de pedidos:

- "Publica estas 5 imagens amanhã às 9h com esta legenda."
- "Agenda este Reels para sexta às 18h30."
- "Mostra a fila." / "Cancela o post de quinta."

## Se travar

| Mensagem | O que fazer |
|---|---|
| Falta preencher no arquivo .env | Rode de novo o passo indicado (1.2, 1.6 ou 2). |
| Use a chave secreta nova, que começa com sb_secret_ | Settings → API Keys → Secret keys, copie a `sb_secret_...` para `SUPABASE_SECRET_KEY`. |
| A Meta não reconheceu o ID do app com essa chave secreta | Confira os dois em Configurações do app → Básico e rode `npm run configurar`. |
| A Meta aprovou, mas não mostrou nenhum Instagram | O Instagram precisa ser profissional e ligado a uma Página que a pessoa administra, e os dois precisam ser marcados na tela da Meta. Corrija e rode `npm run conectar -- --retomar`. |
| A Meta mostrou mais de um Instagram / mostrou outro | `npm run conectar -- --retomar --instagram @certo` (sem novo login). |
| A permissão de publicar não foi concedida | Confira `instagram_content_publish` na configuração do login (passo 2.3) e conecte de novo aceitando tudo. |
| A Meta não confirmou a conexão (etapa: troca do código) | O endereço de retorno do passo 2.4 tem de ser idêntico ao do `npm run configurar`. Confira e conecte de novo. |
| Este pedido de conexão expirou | Passaram os 30 minutos ou o link já foi usado: `npm run conectar` de novo. |
| Erro de permissão ao publicar, com a Página num portfólio empresarial | A Meta pode pedir também `ads_management` e `ads_read`. Adicione as duas na configuração do login e conecte de novo. |
| Publicação bloqueada pela Página | A Página pode exigir a autorização de publicação da Meta (PPA). A pessoa conclui essa autorização no Facebook e tenta de novo. |
| O Instagram pediu uma pausa nas publicações | Limite da Meta (100 posts por 24 horas). O publicador tenta de novo sozinho em 30 minutos. |
| O arquivo passa do limite de envio do Supabase | Vídeo acima de 50 MB: rode de novo com `--comprimir` (precisa do ffmpeg: `brew install ffmpeg`). |

Para olhar por dentro: no painel do Supabase, **Edge Functions → publicador → Logs** mostra cada rodada; **Integrations → Cron** mostra o agendador.

## Atualizar depois

Dentro da pasta: `git pull`, `npm test` e `npm run supabase:instalar`. A migração pode ser aplicada de novo sem apagar nada, e a função é republicada. Para desfazer tudo do lado da Meta: no Facebook, em **Integrações comerciais**, remova o app; aqui, `npm run desconectar -- --sim`.
