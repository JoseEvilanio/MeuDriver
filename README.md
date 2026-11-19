# MeuDrive

Aplicação web de armazenamento de arquivos com Supabase Auth, PostgreSQL e Supabase Storage. O app usa somente Supabase Storage para listar, enviar, abrir, baixar e gerenciar arquivos. Arquivos e recursos Cloudflare R2 que já existiam foram mantidos intactos, mas não aparecem nem podem ser gerenciados pelo app. O catálogo e os arquivos baixados são mantidos no cache local do navegador; sincronização de pastas do Windows e sincronização automática de alterações locais ainda não estão implementadas.

## Escopo atual

O app permite autenticar, enviar arquivos e pastas, consultar e pesquisar arquivos e baixar conteúdo. Uploads não vazios usam envio retomável pelo Supabase Storage. O catálogo e os arquivos baixados são mantidos em cache no IndexedDB do navegador, separados por usuário. O explorador mostra 10 arquivos por página, com ícones por tipo.

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

Inclua as variáveis no ambiente **Production** (e também em Preview, se necessário) e faça um novo deploy depois de alterá-las, pois o Vite incorpora os valores durante a build.

## Upload de arquivos

É possível selecionar vários arquivos de uma vez ou escolher uma pasta. Arquivos novos não sobrescrevem objetos existentes; uploads não vazios podem ser retomados ao selecionar novamente o mesmo arquivo. Ao concluir o lote, um modal confirma o sucesso. O progresso inclui bytes enviados, velocidade e estimativa de tempo.

No explorador, clique no nome para abrir o arquivo. Texto e código (como TXT, Markdown, CSV, JSON, HTML, CSS, JavaScript, TypeScript, Python e SQL) podem ser editados no app e salvos no mesmo caminho. Imagens, PDFs, áudios e vídeos têm pré-visualização quando suportada pelo navegador. Para formatos sem pré-visualização, baixe e use o aplicativo apropriado no computador. O app não edita formatos como DOCX ou XLSX internamente e não mantém histórico de versões.

**Integração antiga:** Cloudflare R2 foi removido do frontend. Objetos e recursos R2 existentes, assim como a migration e a Edge Function relacionadas no Supabase, não foram apagados nem alterados; eles não são listados, lidos ou gerenciados pelo app.

## Usuários e níveis de acesso

Na tela **Permissões**, o usuário Master pode convidar usuários e alterar os níveis entre Colaborador e Gerente. Novas contas recebem o nível Colaborador e precisam definir uma senha ao abrir o convite. O Gerente tem acesso a todos os arquivos, mas não pode administrar usuários nem alterar níveis; somente o Master pode fazê-lo. A Edge Function `manage-users` valida a sessão e o nível Master, envia/renova convites para `VITE_APP_URL` e processa alterações de nível. Para implantá-la pela CLI, use `supabase functions deploy manage-users --project-ref <PROJECT_ID>`. A chave `service_role` deve permanecer somente no ambiente seguro da Edge Function; nunca a coloque em `VITE_*` nem no frontend.

Configure um servidor SMTP de produção em **Authentication > SMTP Settings** para que os convites sejam entregues. Em **Authentication > URL Configuration > Site URL**, defina `https://meu-driver.vercel.app`; em **Redirect URLs**, permita `https://meu-driver.vercel.app/**` e a URL de desenvolvimento, por exemplo `http://localhost:5173/**`. Convites agora sempre retornam ao domínio estável de produção, não ao endereço temporário de Preview.

Para reforçar o isolamento em produção, rode `npm run security:rls` e verifique que não reste uma policy permissiva de upload para todos os usuários autenticados (`authenticated_upload_to_meudriver`) no diretório `supabase/migrations`.

As migrations podem ser aplicadas pelo SQL Editor do Supabase ou com o Supabase CLI após vincular este repositório ao projeto. A seleção de pastas depende do suporte do navegador a `webkitdirectory`.

Para atualizar a lista sem clique manual, aplique também `supabase/migrations/20261112092300_enable_storage_realtime.sql` para objetos do Storage.

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
