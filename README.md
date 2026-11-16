# MeuDrive

Aplicação web de armazenamento de arquivos com Supabase Auth e Supabase Storage. O painel consulta dados reais do bucket para o usuário autenticado. O catálogo e os arquivos baixados são mantidos no cache local do navegador; sincronização de pastas do Windows, fila offline e sincronização automática de alterações locais ainda não estão implementadas.

## Escopo atual

O app permite autenticar, enviar arquivos e pastas, retomar envios interrompidos, atualizar objetos existentes, consultar e pesquisar os objetos acessíveis no Storage e baixar arquivos. O catálogo e os arquivos baixados são mantidos em cache no IndexedDB do navegador, separados por usuário e bucket. O explorador mostra 10 arquivos por página, com ícones por tipo. O painel mostra contagem, pastas e tamanho calculados a partir dos objetos listados no bucket.

Colaboradores veem e gerenciam somente os próprios arquivos. Gerentes e Master podem acessar todos os arquivos do bucket; somente o Master administra usuários e altera níveis. As políticas RLS necessárias precisam estar aplicadas no projeto Supabase. Com uma sessão ativa, mudanças no bucket são recebidas pelo Supabase Realtime e atualizam a listagem automaticamente enquanto a aplicação está aberta. Se não houver sessão, o app solicita login em vez de mostrar conteúdo demonstrativo.

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
- `VITE_APP_URL` — URL estável de produção para o link de conclusão de convites (padrão: `https://meu-driver.vercel.app`).

Inclua as variáveis no ambiente **Production** (e também em Preview, se necessário) e faça um novo deploy depois de alterá-las, pois o Vite incorpora os valores durante a build. Se o login funcionar, mas o envio falhar por RLS, aplique as migrations de Storage descritas abaixo no mesmo projeto Supabase.

## Upload de arquivos

Na seção de upload, é possível selecionar vários arquivos de uma vez ou escolher uma pasta. O conteúdo é enviado ao bucket configurado no Supabase Storage e os caminhos das subpastas são preservados. Espaços e caracteres aceitos pelo Storage permanecem originais; segmentos com caracteres não aceitos, como acentos/Unicode, são codificados de forma reversível porque a API do Storage os rejeita na chave física. O explorador decodifica esses segmentos para exibir o nome original, inclusive em objetos antigos.

Os objetos usam um caminho estável por usuário e caminho relativo da pasta. Antes de enviar, o app verifica se a pasta de destino ou o caminho do arquivo já existe. Em caso de conflito, nenhum arquivo do lote é enviado e o app pede para renomear a pasta ou o arquivo; uploads novos não sobrescrevem objetos existentes. Ao concluir o envio, um modal confirma o sucesso; a seleção e as prévias locais só são limpas após clicar em **OK**. A barra de progresso é calculada pela quantidade de arquivos concluídos, com avanço parcial durante arquivos TUS grandes, para permanecer alinhada ao contador. Arquivos acima de 6 MiB são enviados pelo protocolo TUS resumível; arquivos menores usam o upload padrão. Se um lote for interrompido, o progresso concluído fica salvo localmente no navegador e a seleção idêntica retoma os arquivos pendentes. A substituição intencional de um arquivo existente continua disponível ao abri-lo no explorador e selecionar uma versão revisada.

No explorador, clique no nome para abrir o arquivo. Texto e código (como TXT, Markdown, CSV, JSON, HTML, CSS, JavaScript, TypeScript, Python e SQL) podem ser editados no app e salvos no mesmo caminho da nuvem. Imagens, PDFs, áudios e vídeos têm pré-visualização quando suportada pelo navegador. Para outros formatos, use o aplicativo apropriado no computador, selecione a versão revisada em “Substituir arquivo” e ela será enviada para substituir o objeto atual. O app não edita formatos como DOCX ou XLSX internamente e não mantém histórico de versões; a substituição depende das permissões de atualização do Storage.

Antes do primeiro envio, crie no painel Supabase (Storage > Buckets) um bucket cujo nome corresponda a `VITE_SUPABASE_BUCKET` no `.env` (o padrão deste projeto é `MeuDriver`). Ajuste o limite de tamanho do bucket em Storage > Buckets > bucket e confira também o limite global em Storage > Settings. O TUS permite retomar transferências grandes, mas não contorna limites de bucket nem o limite máximo do plano Supabase. A conta deve estar logada no app. As migrations em `supabase/migrations` criam os perfis e aplicam RLS no banco e no Storage: colaboradores podem ler, inserir, atualizar e excluir somente objetos sob o próprio ID; a conta `jose_evilanio@hotmail.com` recebe o nível Master e pode acessar todos os objetos do bucket `MeuDriver`.

## Usuários e níveis de acesso

Na tela **Permissões**, o usuário Master pode convidar usuários e alterar os níveis entre Colaborador e Gerente. Novas contas recebem o nível Colaborador e precisam definir uma senha ao abrir o convite. O Gerente tem acesso a todos os arquivos, mas não pode administrar usuários nem alterar níveis; somente o Master pode fazê-lo. A Edge Function `manage-users` valida a sessão e o nível Master, envia/renova convites para `VITE_APP_URL` e processa alterações de nível. Para implantá-la pela CLI, use `supabase functions deploy manage-users --project-ref <PROJECT_ID>`. A chave `service_role` deve permanecer somente no ambiente seguro da Edge Function; nunca a coloque em `VITE_*` nem no frontend.

Configure um servidor SMTP de produção em **Authentication > SMTP Settings** para que os convites sejam entregues. Em **Authentication > URL Configuration > Site URL**, defina `https://meu-driver.vercel.app`; em **Redirect URLs**, permita `https://meu-driver.vercel.app/**` e a URL de desenvolvimento, por exemplo `http://localhost:5173/**`. Convites agora sempre retornam ao domínio estável de produção, não ao endereço temporário de Preview.

Para reforçar o isolamento em produção, rode `npm run security:rls` e verifique que não reste uma policy permissiva de upload para todos os usuários autenticados (`authenticated_upload_to_meudriver`) no diretório `supabase/migrations`.

As migrations podem ser aplicadas pelo SQL Editor do Supabase ou com o Supabase CLI após vincular este repositório ao projeto. A seleção de pastas depende do suporte do navegador a `webkitdirectory`.

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
