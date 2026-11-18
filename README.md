# MeuDrive

Aplicação web de armazenamento de arquivos com Supabase Auth/PostgreSQL e Cloudflare R2 como destino principal dos novos arquivos. O navegador envia partes diretamente ao R2 por URLs pré-assinadas; o Supabase guarda somente metadados. Objetos antigos continuam no Supabase Storage e são consultados em paralelo durante a migração gradual. O catálogo e os arquivos baixados são mantidos no cache local do navegador; sincronização de pastas do Windows e sincronização automática de alterações locais ainda não estão implementadas.

## Escopo atual

O app permite autenticar, enviar arquivos e pastas, retomar multipart do R2 após selecionar novamente o mesmo arquivo, atualizar objetos existentes, consultar e pesquisar arquivos e baixar conteúdo. Novos uploads usam partes de 100 MiB com até três partes em paralelo. O catálogo R2 é consultado no PostgreSQL; o app também mantém leitura dos objetos legados do Supabase Storage. O catálogo e os arquivos baixados são mantidos em cache no IndexedDB do navegador, separados por usuário. O explorador mostra 10 arquivos por página, com ícones por tipo.

Colaboradores veem e gerenciam somente os próprios arquivos. Gerentes e Master podem acessar todos os arquivos do bucket; somente o Master administra usuários e altera níveis. As políticas RLS necessárias precisam estar aplicadas no projeto Supabase. Com uma sessão ativa, mudanças no bucket são recebidas pelo Supabase Realtime e atualizam a listagem automaticamente enquanto a aplicação está aberta. Se não houver sessão, o app solicita login em vez de mostrar conteúdo demonstrativo.

Fila offline fora das sessões multipart, monitoramento de pastas locais, histórico de atividade, dispositivos conectados, compartilhamentos e permissões por empresa dependem de serviços ainda não conectados. As atualizações em tempo real não são um serviço de sincronização em segundo plano: a aba precisa permanecer aberta e eventos ocorridos enquanto desconectado são recuperados na próxima leitura do catálogo.

## Como executar

1. Copie o arquivo `.env.example` para `.env`.
2. Preencha com a URL do projeto Supabase, a anon key e, opcionalmente, o bucket legado.
3. Inicie o app:

```bash
npm install
npm run dev
```

## Deploy na Vercel

Cadastre as variáveis em **Project Settings > Environment Variables**:

- `VITE_SUPABASE_URL` — URL do projeto Supabase.
- `VITE_SUPABASE_ANON_KEY` — chave pública (anon/publishable) do projeto; nunca use `service_role` no frontend.
- `VITE_SUPABASE_BUCKET` — opcional; o padrão é `MeuDriver`.
- `VITE_APP_URL` — URL estável de produção para o link de conclusão de convites (padrão: `https://meu-driver.vercel.app`).
- `VITE_R2_PART_SIZE_BYTES` — opcional e não secreto; padrão `104857600` (100 MiB).
- `VITE_R2_PART_CONCURRENCY` — opcional e não secreto; padrão `3` (faixa aceita: 1–8 partes).

Inclua as variáveis no ambiente **Production** (e também em Preview, se necessário) e faça um novo deploy depois de alterá-las, pois o Vite incorpora os valores durante a build. Para uploads novos, configure também os secrets R2 no Supabase, aplique a migration do catálogo e implante a Edge Function conforme a seção abaixo.

## Upload de arquivos

### Cloudflare R2 (novos arquivos)

O R2 é o destino padrão dos novos arquivos. Aplique primeiro as migrations em `supabase/migrations`, inclusive `20261117000000_add_r2_file_catalog.sql`, e implante a Edge Function:

```bash
supabase functions deploy cloudflare-storage
```

Configure no ambiente de secrets das Edge Functions, nunca no `.env` do Vite nem em variáveis `VITE_*`:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_ENDPOINT` — opcional; se omitido, é derivado do Account ID.
- `R2_REGION` — opcional; padrão `auto`.
- `R2_UPLOAD_EXPIRATION_DAYS` — opcional; validade de sessões abandonadas, padrão 30 dias (1–365).

Crie um bucket privado no Cloudflare R2 e uma chave S3 restrita ao bucket. No CORS do bucket, permita a origem de produção e a de desenvolvimento usadas no app, os métodos `PUT`, `GET` e `HEAD`, os headers `content-type` e `range`, e exponha `ETag`. Não use `*` nas origens de produção. A função assina URLs por 15 minutos e valida o usuário com Supabase Auth antes de emitir URLs ou executar operações.

Exemplo de política CORS para ajustar aos domínios reais:

```json
[
  {
    "AllowedOrigins": ["https://meu-driver.vercel.app", "http://localhost:5173"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "range"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

O upload multipart usa 100 MiB por parte e três partes em paralelo por arquivo; os dois valores podem ser ajustados pelas variáveis não secretas acima. Os arquivos do lote são processados um por vez. Partes existentes são obtidas por `ListParts`; após pausar ou fechar a página, selecione novamente o mesmo arquivo para validar o tamanho, a data/path e uma impressão digital parcial (primeiro/último MiB) e retomar. Essa impressão digital não é um hash completo do arquivo. O botão **Pausar mantendo partes** interrompe os envios em andamento sem cancelar a sessão R2. Arquivos vazios usam um PUT pré-assinado simples. O backend só marca o arquivo concluído depois de concluir no R2 e conferir o tamanho via `HeadObject`. Limites técnicos atuais: até 5 TiB por objeto, 10.000 partes e 5 GiB por parte; o tamanho da parte é aumentado automaticamente para não ultrapassar o número máximo de partes.

As tabelas `drive_files` e `drive_uploads` contêm metadados/sessões, nunca o conteúdo binário. A migration protege leitura com RLS e somente a Edge Function (service role no servidor) faz mutações. A ação `cleanup-expired` cancela sessões expiradas, mas ainda precisa ser chamada por um agendador operacional; o prazo padrão é 30 dias. A reconciliação disponível é por sessão multipart conhecida. Não há migração automática nem varredura de objetos R2 sem registro nesta etapa. Cotas/alertas de 80%, 90% e 100% e limite por usuário ainda não estão implementados.

**Não aplique migrations de produção sem revisão e backup operacional.** Este workspace não tem secrets R2 nem acesso ao projeto para aplicar migrations/deploy ou executar testes reais de integração. Antes de liberar, valide uploads e retomada em um bucket de teste, configure CORS e execute os casos grandes descritos em [docs/prd-cloudflare-r2.md](./docs/prd-cloudflare-r2.md).

Na seção de upload, é possível selecionar vários arquivos de uma vez ou escolher uma pasta. Novos objetos recebem uma chave interna UUID no R2; nome e caminho originais ficam nos metadados do Supabase. Os caminhos dos objetos antigos do Supabase Storage continuam sendo decodificados para exibir nomes originais.

Antes do envio, o backend valida colisões no catálogo R2; uploads novos não sobrescrevem objetos. Ao concluir o lote, um modal confirma o sucesso; a seleção e as prévias locais só são limpas após clicar em **OK**. O progresso inclui bytes enviados, velocidade e estimativa de tempo. O botão para pausar interrompe as partes ativas, sem abortar a sessão; para retomar depois, selecione novamente o mesmo arquivo.

No explorador, clique no nome para abrir o arquivo. Texto e código (como TXT, Markdown, CSV, JSON, HTML, CSS, JavaScript, TypeScript, Python e SQL) podem ser editados no app e salvos no mesmo caminho; substituições de arquivos R2 são carregadas em nova sessão multipart e só passam a ser a versão ativa após a confirmação do R2. Imagens, PDFs, áudios e vídeos têm pré-visualização quando suportada pelo navegador, por URL temporária. Para formatos sem pré-visualização, baixe e use o aplicativo apropriado no computador. O app não edita formatos como DOCX ou XLSX internamente e não mantém histórico de versões.

O bucket legado `VITE_SUPABASE_BUCKET` só é necessário para consultar e manipular objetos antigos do Supabase Storage. Novos arquivos requerem R2 e a migration de catálogo descritos na seção Cloudflare R2. As migrations existentes continuam a proteger o acesso aos arquivos legados; a nova migration protege a leitura de metadados R2 por proprietário e mantém acesso de gerente/Master.

## Usuários e níveis de acesso

Na tela **Permissões**, o usuário Master pode convidar usuários e alterar os níveis entre Colaborador e Gerente. Novas contas recebem o nível Colaborador e precisam definir uma senha ao abrir o convite. O Gerente tem acesso a todos os arquivos, mas não pode administrar usuários nem alterar níveis; somente o Master pode fazê-lo. A Edge Function `manage-users` valida a sessão e o nível Master, envia/renova convites para `VITE_APP_URL` e processa alterações de nível. Para implantá-la pela CLI, use `supabase functions deploy manage-users --project-ref <PROJECT_ID>`. A chave `service_role` deve permanecer somente no ambiente seguro da Edge Function; nunca a coloque em `VITE_*` nem no frontend.

Configure um servidor SMTP de produção em **Authentication > SMTP Settings** para que os convites sejam entregues. Em **Authentication > URL Configuration > Site URL**, defina `https://meu-driver.vercel.app`; em **Redirect URLs**, permita `https://meu-driver.vercel.app/**` e a URL de desenvolvimento, por exemplo `http://localhost:5173/**`. Convites agora sempre retornam ao domínio estável de produção, não ao endereço temporário de Preview.

Para reforçar o isolamento em produção, rode `npm run security:rls` e verifique que não reste uma policy permissiva de upload para todos os usuários autenticados (`authenticated_upload_to_meudriver`) no diretório `supabase/migrations`.

As migrations podem ser aplicadas pelo SQL Editor do Supabase ou com o Supabase CLI após vincular este repositório ao projeto. A seleção de pastas depende do suporte do navegador a `webkitdirectory`.

Para atualizar a lista sem clique manual, aplique também `supabase/migrations/20261112092300_enable_storage_realtime.sql` para objetos legados. Alterações do catálogo R2 usam eventos Realtime da tabela `drive_files`; depois do evento, o app consulta novamente os metadados sujeitos a RLS.

O catálogo em cache permite mostrar a listagem enquanto o Storage é consultado. Após baixar um arquivo, a cópia fica no IndexedDB e o próximo download poderá reutilizá-la se o tamanho e a data de atualização ainda corresponderem ao Storage. Esse cache existe somente neste perfil do navegador, não cria arquivos na pasta do Windows e pode ser removido pelo navegador quando faltar espaço. A seção Configuração permite limpar o cache do usuário atual.

## Interface

A interface usa componentes locais no padrão shadcn/ui (Button, Badge, Card e Input), com primitivas Radix UI, variantes via class-variance-authority e ícones Lucide. Os componentes ficam em `src/components/ui` e podem ser ajustados ao design do produto sem depender de um pacote fechado de componentes.

O acesso é feito pelo botão da barra lateral e usa login do Supabase; o cadastro pelo cliente está desativado. A área de transferência usa uma cena WebGL/Three.js transparente com pastas de origem e destino e um documento animado entre elas. A contagem exibida acompanha os uploads concluídos e a cena respeita a preferência de movimento reduzido do sistema.

## Scripts

- `npm run dev` — servidor de desenvolvimento
- `npm run build` — compila a aplicação para produção
- `npm run preview` — visualiza a build localmente

## Observações

Este projeto foi implementado como uma interface funcional e visualmente consistente para representar a visão do produto e a arquitetura da solução proposta.
