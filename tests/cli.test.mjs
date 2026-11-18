import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.mjs';
import { prepareMedia, readCaption, resolvePostId } from '../src/commands.mjs';
import { parseEnv } from '../src/env.mjs';
import { checkImage, imageSize, prepareImages } from '../src/media.mjs';
import { formatWhen, parseWhen } from '../src/time.mjs';

// Cabeçalhos mínimos de imagem, só com o que a leitura de dimensões precisa.
function jpeg(width, height, orientation = 1) {
  const exif = Buffer.alloc(36);
  exif.write('Exif\0\0', 0, 'latin1');
  exif.write('MM', 6, 'latin1');
  exif.writeUInt16BE(42, 8);
  exif.writeUInt32BE(8, 10);
  exif.writeUInt16BE(1, 14);
  exif.writeUInt16BE(0x0112, 16);
  exif.writeUInt16BE(3, 18);
  exif.writeUInt32BE(1, 20);
  exif.writeUInt16BE(orientation, 24);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, exif.length + 2]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}
function png(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}
function webp(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'latin1');
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8X', 12, 'latin1');
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'publicador-teste-'));

test('lê as dimensões de JPEG, PNG e WebP e entende a rotação do celular', () => {
  assert.deepEqual(imageSize(jpeg(1080, 1350)), { format: 'jpeg', width: 1080, height: 1350, orientation: 1 });
  assert.equal(imageSize(jpeg(1350, 1080, 6)).orientation, 6);
  assert.deepEqual(imageSize(png(1080, 1080)), { format: 'png', width: 1080, height: 1080 });
  assert.deepEqual(imageSize(webp(1080, 1350)), { format: 'webp', width: 1080, height: 1350 });
  assert.equal(imageSize(Buffer.from('não é imagem')), null);
});

test('recusa proporções que o feed não aceita e fotos estreitas demais', () => {
  checkImage({ width: 1080, height: 1350 }, 0);
  checkImage({ width: 1350, height: 1080, orientation: 6 }, 0);
  assert.throws(() => checkImage({ width: 1080, height: 1920 }, 1), /Imagem 2: 1080 × 1920 está fora/);
  assert.throws(() => checkImage({ width: 2000, height: 1000 }, 0), /fora/);
  assert.throws(() => checkImage({ width: 300, height: 300 }, 0), /largura mínima/);
});

test('JPEG pronto vai sem conversão; PNG é convertido; proporções diferentes geram aviso', () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'a.jpg'), jpeg(1080, 1350));
  fs.writeFileSync(path.join(dir, 'b.png'), png(1080, 1080));
  const converted = [];
  const fakeConvert = (source, target) => { converted.push(path.basename(source)); fs.writeFileSync(target, jpeg(1080, 1080)); };
  const work = temp();
  const { images, warnings } = prepareImages([path.join(dir, 'a.jpg'), path.join(dir, 'b.png')], work, fakeConvert);
  assert.deepEqual(converted, ['b.png']);
  assert.deepEqual(images.map(image => path.basename(image.file)), ['01.jpg', '02.jpg']);
  assert.match(warnings[0], /proporções diferentes/);
});

test('horário no fuso da pessoa, inclusive no formato brasileiro', () => {
  const now = new Date('2026-11-18T10:00:00Z');
  assert.equal(parseWhen('2026-11-20 09:00', 'America/Sao_Paulo', now).toISOString(), '2026-11-20T12:00:00.000Z');
  assert.equal(parseWhen('20/11/2026 9h30', 'America/Sao_Paulo', now).toISOString(), '2026-11-20T12:30:00.000Z');
  assert.equal(parseWhen('20/11 às 18:45', 'America/Sao_Paulo', now).toISOString(), '2026-11-20T21:45:00.000Z');
  assert.equal(parseWhen('2026-11-20T09:00', 'Europe/Lisbon', now).toISOString(), '2026-11-20T09:00:00.000Z');
  assert.equal(parseWhen('2026-11-20T09:00:00-03:00', 'Asia/Tokyo', now).toISOString(), '2026-11-20T12:00:00.000Z');
  assert.equal(parseWhen('agora', 'America/Sao_Paulo', now).toISOString(), now.toISOString());
  assert.throws(() => parseWhen('amanhã de manhã', 'America/Sao_Paulo', now), /Não entendi/);
  assert.throws(() => parseWhen('2026-02-30 10:00', 'America/Sao_Paulo', now), /não existe/);
  assert.equal(formatWhen('2026-11-20T12:00:00Z', 'America/Sao_Paulo'), '20/11/2026 às 09:00');
});

test('legenda: obrigatória e dentro dos limites do Instagram', () => {
  assert.equal(readCaption({ caption: '  Olá\r\nmundo  ' }), 'Olá\nmundo');
  assert.equal(readCaption({ captionFile: 'x.txt' }, () => 'Do arquivo'), 'Do arquivo');
  assert.throws(() => readCaption({}), /Informe a legenda/);
  assert.throws(() => readCaption({ caption: 'a'.repeat(2201) }), /2.200/);
  assert.throws(() => readCaption({ caption: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ') }), /31 hashtags/);
});

test('decide o tipo do post pelos arquivos', () => {
  const tools = {
    prepareImages: files => ({ images: files.map(file => ({ file, width: 1080, height: 1350, bytes: 1000 })), warnings: [] }),
    prepareVideo: file => ({ file, bytes: 1000, info: null, warnings: [] }),
  };
  assert.equal(prepareMedia(['a.jpg'], '/tmp', {}, tools).kind, 'image');
  assert.equal(prepareMedia(['a.jpg', 'b.PNG'], '/tmp', {}, tools).kind, 'carousel');
  assert.equal(prepareMedia(['video.mov'], '/tmp', {}, tools).kind, 'reel');
  assert.throws(() => prepareMedia(['a.jpg', 'b.mp4'], '/tmp', {}, tools), /Carrossel com vídeo/);
  assert.throws(() => prepareMedia(['a.mp4', 'b.mp4'], '/tmp', {}, tools), /um vídeo por vez/);
  assert.throws(() => prepareMedia(Array.from({ length: 11 }, (_, i) => `${i}.jpg`), '/tmp', {}, tools), /até 10/);
});

test('aceita os 8 primeiros caracteres do id', async () => {
  const ctx = { api: { rpc: async () => [{ id: 'abcdef12-1111-4111-8111-111111111111' }, { id: 'abcdef99-1111-4111-8111-111111111111' }] } };
  assert.equal(await resolvePostId(ctx, 'abcdef12'), 'abcdef12-1111-4111-8111-111111111111');
  await assert.rejects(resolvePostId(ctx, 'abcdef'), /Mais de um/);
  await assert.rejects(resolvePostId(ctx, 'zz'), /Informe o id/);
});

test('lê o .env sem aspas e ignora comentários', () => {
  assert.deepEqual(parseEnv('# comentário\nSUPABASE_URL="https://a.supabase.co"\nFUSO_HORARIO=America/Sao_Paulo\n'),
    { SUPABASE_URL: 'https://a.supabase.co', FUSO_HORARIO: 'America/Sao_Paulo' });
});

// Fluxo completo do "publicar --teste --quando" com o Supabase de mentira.
function fakeApi() {
  const calls = { rpc: [], upload: [], call: [] };
  const account = { account: 'principal', username: 'consultorio.exemplo', connected_at: '2026-11-18T10:00:00Z', expires_at: null };
  const post = extra => ({ id: calls.rpc.find(c => c.name === 'instagram_publisher_create_post')?.args.p_post, title: 'Dicas de sono',
    username: 'consultorio.exemplo', kind: 'carousel', state: 'draft', ...extra });
  const api = {
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      if (name === 'instagram_publisher_status') return { accounts: [account], queue: { scheduled: 0, failed: 0 } };
      if (name === 'instagram_publisher_create_post') return post();
      if (name === 'instagram_publisher_schedule') return post({ state: 'scheduled', scheduled_at: args.p_when });
      if (name === 'instagram_publisher_list') return [post()];
      return null;
    },
    upload: async (objectPath, file, type) => { calls.upload.push({ objectPath, type }); },
    call: async (action, body) => { calls.call.push({ action, body }); return { status: 200, data: { state: 'ok', message: 'O Instagram de @consultorio.exemplo aceitou as 2 imagens e a legenda. Nada foi publicado.' } }; },
  };
  return { api, calls };
}

test('publicar: envia na ordem, cria o rascunho, testa e agenda no horário de Brasília', async () => {
  const dir = temp();
  for (const name of ['01.jpg', '02.jpg']) fs.writeFileSync(path.join(dir, name), jpeg(1080, 1350));
  const { api, calls } = fakeApi();
  const lines = [];
  const code = await main(['publicar', '--legenda', 'Dicas de sono\n#sono', '--teste', '--quando', '2026-11-20 09:00',
    path.join(dir, '01.jpg'), path.join(dir, '02.jpg')], { api, env: { SUPABASE_URL: 'https://a.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_xxxxxxxxxxxxxxxxxxxx' },
    log: line => lines.push(line), fail: line => lines.push(line) });
  assert.equal(code, 0, lines.join('\n'));
  const postId = calls.rpc.find(c => c.name === 'instagram_publisher_create_post').args.p_post;
  assert.deepEqual(calls.upload.map(item => item.objectPath), [`${postId}/01.jpg`, `${postId}/02.jpg`]);
  assert.equal(calls.rpc.find(c => c.name === 'instagram_publisher_create_post').args.p_kind, 'carousel');
  assert.equal(calls.call[0].action, 'test');
  assert.equal(calls.rpc.find(c => c.name === 'instagram_publisher_schedule').args.p_when, '2026-11-20T12:00:00.000Z');
  assert.ok(lines.some(line => line.includes('sai sozinho em 20/11/2026 às 09:00 no @consultorio.exemplo')), lines.join('\n'));
});

test('erros saem em português, sem rastro técnico, e o código de saída é 1', async () => {
  const lines = [];
  const code = await main(['publicar', '--opcao-que-nao-existe'], { env: { SUPABASE_URL: 'https://a.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_xxxxxxxxxxxxxxxxxxxx' },
    log: line => lines.push(line), fail: line => lines.push(line) });
  assert.equal(code, 1);
  assert.match(lines[0], /^Erro: Opção desconhecida/);
  const missing = [];
  assert.equal(await main(['status'], { env: {}, log: () => {}, fail: line => missing.push(line) }), 1);
  assert.match(missing[0], /SUPABASE_URL, SUPABASE_SECRET_KEY/);
});
