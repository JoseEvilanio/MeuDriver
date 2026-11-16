# MeuDrive

Aplicação web de armazenamento de arquivos com Supabase Auth e Supabase Storage. O painel consulta dados reais do bucket para o usuário autenticado. O catálogo e os arquivos baixados são mantidos no cache local do navegador; sincronização de pastas do Windows, fila offline e sincronização automática de alterações locais ainda não estão implementadas.

## Escopo atual

O app permite autenticar, enviar arquivos e pastas, retomar envios interrompidos, atualizar objetos existentes, consultar e pesquisar os objetos acessíveis no Storage e baixar arquivos. O catálogo e os arquivos baixados são mantidos em cache no IndexedDB do navegador, separados por usuário e bucket. O explorador mostra 10 arquivos por página, com ícones por tipo. O painel mostra contagem, pastas e tamanho calculados a partir dos objetos listados no bucket.

O explorador e os indicadores estão limitados ao prefixo do ID do usuário autenticado. As políticas RLS necessárias precisam estar aplicadas no projeto Supabase. Com uma sessão ativa, mudanças no bucket são recebidas pelo Supabase Realtime e atualizam a listagem automaticamente enquanto a aplicação está aberta. Se não houver sessão, o app solicita login em vez de mostrar conteúdo demonstrativo.

Fila offline persistente, monitoramento de pastas locais, histórico de atividade, dispositivos conectados, compartilhamentos e permissões por empresa dependem de serviços ainda não conectados. As atualizações em tempo real não são um serviço de sincronização em segundo plano: a aba precisa permanecer aberta e eventos ocorridos enquanto desconectado são recuperados na próxima leitura do Storage.

## Como executar

1. Copie o arquivo `.env.example` para `.env`.
2. Preencha com a URL do projeto Supabase, a anon key e o bucket desejado.
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

Inclua as variáveis no ambiente **Production** (e também em Preview, se necessário) e faça um novo deploy depois de alterá-las, pois o Vite incorpora os valores durante a build. Se o login funcionar, mas o envio falhar por RLS, aplique as migrations de Storage descritas abaixo no mesmo projeto Supabase.

## Upload de arquivos

Na seção de upload, é possível selecionar vários arquivos de uma vez ou escolher uma pasta. O conteúdo é enviado ao bucket configurado no Supabase Storage; ao enviar uma pasta, os caminhos das subpastas são preservados com os nomes originais, inclusive espaços e acentos. Objetos antigos que tenham sido codificados em versões anteriores continuam sendo decodificados no explorador.

Os objetos usam um caminho estável por usuário e caminho relativo da pasta. Antes de enviar, o app verifica se a pasta de destino ou o caminho do arquivo já existe. Em caso de conflito, nenhum arquivo do lote é enviado e o app pede para renomear a pasta ou o arquivo; uploads novos não sobrescrevem objetos existentes. Arquivos acima de 6 MiB são enviados pelo protocolo TUS resumível, com progresso em bytes e retomada após interrupções; arquivos menores usam o upload padrão. Se um lote for interrompido, o progresso concluído fica salvo localmente no navegador e a seleção idêntica retoma os arquivos pendentes. A substituição intencional de um arquivo existente continua disponível ao abri-lo no explorador e selecionar uma versão revisada.

No explorador, clique no nome para abrir o arquivo. Texto e código (como TXT, Markdown, CSV, JSON, HTML, CSS, JavaScript, TypeScript, Python e SQL) podem ser editados no app e salvos no mesmo caminho da nuvem. Imagens, PDFs, áudios e vídeos têm pré-visualização quando suportada pelo navegador. Para outros formatos, use o aplicativo apropriado no computador, selecione a versão revisada em “Substituir arquivo” e ela será enviada para substituir o objeto atual. O app não edita formatos como DOCX ou XLSX internamente e não mantém histórico de versões; a substituição depende das permissões de atualização do Storage.

Antes do primeiro envio, crie no painel Supabase (Storage > Buckets) um bucket cujo nome corresponda a `VITE_SUPABASE_BUCKET` no `.env` (o padrão deste projeto é `MeuDriver`). Ajuste o limite de tamanho do bucket em Storage > Buckets > bucket e confira também o limite global em Storage > Settings. O TUS permite retomar transferências grandes, mas não contorna limites de bucket nem o limite máximo do plano Supabase. O Storage aplica RLS por padrão, então também é necessário aplicar a migration `supabase/migrations/20261111073500_user_scoped_upserts.sql` ao projeto. Ela permite inserir, listar e atualizar somente objetos na pasta do ID do usuário autenticado dentro do bucket `MeuDriver`; não concede exclusão. A conta deve estar logada no app.

Para reforçar o isolamento em produção, rode `npm run security:rls` e verifique que não reste uma policy permissiva de upload para todos os usuários autenticados (`authenticated_upload_to_meudriver`) no diretório `supabase/migrations`.

A migration pode ser aplicada pelo SQL Editor do Supabase ou com o Supabase CLI após vincular este repositório ao projeto. A seleção de pastas depende do suporte do navegador a `webkitdirectory`.

Para atualizar a lista sem clique manual, aplique também `supabase/migrations/20261112092300_enable_storage_realtime.sql`, que inclui `storage.objects` na publicação `supabase_realtime`. O cliente recebe somente eventos permitidos pelas políticas RLS e consulta novamente o Storage para atualizar os arquivos. Rajadas de eventos são agrupadas para evitar consultas simultâneas repetidas; respostas temporárias 429/5xx são tentadas novamente com espera crescente.

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
