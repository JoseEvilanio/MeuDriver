# Auditoria tecnica e plano de migracao AWS

## Estado atual

- Front-end web: React 19, TypeScript, Vite 8 e componentes Radix UI.
- Autenticacao atual: Supabase Auth por senha, sessao persistente e refresh automatico.
- Banco atual: Supabase PostgreSQL.
- Backend atual: Edge Functions Deno no Supabase.
- Armazenamento legado: Supabase Storage no bucket configurado por `VITE_SUPABASE_BUCKET`.
- Armazenamento novo atual: Cloudflare R2 multipart, chamado diretamente pelo navegador com URLs assinadas.
- Identidade: `auth.users.id` e perfis em `user_profiles`.
- Papéis: Master, Manager e Collaborator.
- Metadados R2: `drive_files` e `drive_uploads`.
- Pastas: representadas por caminhos textuais e derivados do objeto, sem tabela dedicada de pastas.
- Cache: IndexedDB por usuario com catalogo e arquivos baixados.
- Tempo real: Realtime do Supabase para catalogo R2 e objetos legados.

## Modelo de dados identificado

### `user_profiles`

- `id` referencia `auth.users(id)`.
- `email`.
- `role` limitado a `master`, `manager` ou `collaborator`.
- `created_at`.

### `drive_files`

- `id`, `user_id`, `folder_id` reservado.
- `original_name`, `original_path`, `storage_key`, `bucket_name`.
- `mime_type`, `file_extension`, `file_size`, `etag`.
- `storage_provider` para `cloudflare_r2` ou `supabase`.
- `upload_status`, `file_fingerprint`, timestamps e exclusao logica.
- RLS permite acesso ao proprio arquivo ou acesso ampliado para Manager/Master.

### `drive_uploads`

- `id`, `user_id`, `file_id`, `upload_id`, `storage_key`.
- tamanho total, tamanho da parte, tipo MIME e fingerprint parcial.
- partes concluidas em array, status e validade.
- RLS e operacoes administrativas protegidas pela Edge Function.

## Fluxos existentes

- Login: Supabase Auth com senha.
- Convites e niveis: Edge Function `manage-users`, restrita ao Master.
- Upload legado: upload direto/TUS no Supabase Storage.
- Upload novo: inicio multipart em Edge Function, partes enviadas diretamente pelo navegador e conclusao no servidor.
- Retomada: busca de partes no R2, selecao novamente do arquivo e confirmacao por metadados e amostra parcial.
- Catalogo: metadados R2 no PostgreSQL combinados com objetos legados listados do Supabase.
- Download: URL assinada ou download Supabase conforme o provedor.
- Organizacao: pastas derivadas dos caminhos originais.
- Exclusao e substituicao: operacoes autorizadas pela Edge Function ou pelas politicas RLS existentes.

## Riscos da migracao atual

1. Existem duas fontes de dados e objetos, Cloudflare R2 e Supabase Storage.
2. O fingerprint parcial atual nao substitui um checksum SHA-256 integral.
3. As pastas sao implicitamente derivadas de texto; nao existe uma tabela canônica de pastas.
4. A retomada depende de o usuario reselecionar o mesmo arquivo.
5. A lista de arquivos e pastas ainda nao possui todas as cotas operacionais.
6. Limpeza de multipart nao possui agendamento completo.
7. O projeto nao contem infraestrutura AWS como codigo.
8. O workspace nao contem credenciais AWS nem confirmacao de acesso ao ambiente AWS.

## Arquitetura AWS recomendada

Manter a transicao gradual:

1. Front-end React continua na hospedagem atual.
2. Supabase Auth pode permanecer temporariamente como ponte ou ser substituido pelo Cognito em uma segunda etapa.
3. Amazon API Gateway recebe APIs separadas por responsabilidade.
4. AWS Lambda autentica, autoriza e coordena upload, metadados e operacoes.
5. Amazon RDS PostgreSQL guarda usuarios, pastas, arquivos e sessoes multipart.
6. Amazon S3 guarda o conteudo em um bucket privado com SSE-S3.
7. AWS Secrets Manager guarda a credencial do banco, quando o custo estiver dentro do planejamento.
8. CloudWatch recebe logs, metricas e alarmes operacionais.
9. A unica region operacional inicial sera `sa-east-1`, sem recursos de alta disponibilidade ou replicacao.

Nao colocar credenciais AWS no frontend. Nao enviar o arquivo completo pela Lambda ou API Gateway.

## Plano de execucao em etapas

### Etapa 1 - Estrutura de dados AWS

- Criar migrations PostgreSQL para usuarios, pastas, arquivos, uploads e partes.
- Migrar perfis e relacionamentos existentes sem apagar registros.
- Adicionar indexes, constraints, timestamps, exclusao logica e chave estrangeiras.
- Preservar uma tabela ou coluna de origem para permitir rastreabilidade do Supabase/R2.

### Etapa 2 - Operacao dual

- Adicionar um adaptador de armazenamento no backend.
- Manter Supabase Storage e R2 como provedores legados durante a transicao.
- Criar S3 como provedor padrao dos novos objetos.
- Nao migrar objetos automaticamente.

### Etapa 3 - Upload S3

- Lambda inicia e registra a sessao multipart no RDS.
- Browser envia partes pelo tamanho configurado para o S3.
- Lambda renova URLs de partes, consulta `ListParts`, conclui multipart e confirma `HeadObject`.
- RDS somente muda para concluido apos confirmacao real no S3.
- Implementar concorrencia limitada, retry, pause, resume, cancelamento e checksum SHA-256.

### Etapa 4 - Catalogo e operacoes

- Lambda implementa listar, consultar, renomear, mover, excluir e obter URLs.
- Criar tabelas e APIs para pastas reais.
- Conectar o front-end ao API Gateway sem alterar visualmente o gerenciador.
- Manter URLs temporarias fora do cache persistente.

### Etapa 5 - Autenticacao

- Avaliar a migracao do Supabase Auth para Cognito.
- Preservar os IDs existentes ou criar uma tabela de vinculo Supabase/Cognito.
- Executar migracao gradual e manter os usuarios e arquivos sem perda de acesso.
- Para compatibilidade inicial, o Lambda pode validar Cognito ou continuar validando Supabase durante a etapa dual.

### Etapa 6 - Rede e seguranca

- RDS privado em sub-redes privadas.
- Lambda em sub-redes privadas somente se houver necessidade comprovada de acesso ao RDS privado.
- Security Groups entre Lambda e PostgreSQL.
- Endpoint S3 Gateway VPC se o custo/NAT justificar.
- Sem NAT Gateway, RDS Proxy, replica, CloudFront ou alta disponibilidade nesta fase.
- CORS restrito aos dominios oficiais do MeuDrive.

### Etapa 7 - Migracao de dados

- Fazer backup completo antes da operacao.
- Exportar perfis, arquivos, metadados e relacionamentos.
- Importar metadados em lotes, sem apagar os dados originais.
- Validar contagens, permissoes, tamanhos e hashes.
- Migrar objetos para S3 somente com autorizacao e apos backup.
- Executar uma janela de reversao documentada.

### Etapa 8 - Testes e operacao

- Validar 1 MB, 50 MB, 500 MB, 1 GB, 5 GB, 10 GB e 20 GB.
- Testar interrupcao, retomada, expiracao de URL, concorrencia e falhas de rede.
- Testar S3, RDS, Lambda e API separadamente.
- Validar integridade por checksum, download e metas no RDS.
- Agendar abort de multipart incompleto apos 7 dias.
- Configurar CloudWatch Logs, budgets e alarmes.

## Recursos AWS que seriam criados

Somente apos aprovacao explicita:

- Amazon S3: bucket privado, bloqueio de acesso publico, SSE-S3 e lifecycle.
- AWS Lambda: funcoes separadas para autenticacao, usuarios, arquivos, pastas, upload e download.
- Amazon API Gateway HTTP API.
- Amazon RDS PostgreSQL: instância pequena para iniciar, sem alta disponibilidade.
- Amazon Cognito User Pool: opcional e sujeito a compatibilidade da migracao.
- Amazon CloudWatch Logs, metricas e alarmes basicos.
- AWS Budgets para avisos de consumo.
- AWS Secrets Manager somente se o custo mensal estiver aprovado.

## Recursos que nao serao criados nesta fase

- EC2.
- Kubernetes.
- NAT Gateway.
- RDS Proxy.
- Replica ou Multi-AZ.
- CloudFront.
- Replicacao entre regioes.
- S3 versioning.
- Backups adicionais pagos alem das exigencias operacionais.
- Recursos em multiplas regioes.

## Custo e aprovacao

Nao existe base suficiente para calcular uma estimativa definitiva sem configuracao da conta AWS, region, tamanho do RDS e volume de dados.

Pontos de custo conhecidos que exigem verificacao:

- RDS PostgreSQL pode gerar custo fixo.
- O endereco privado e conectividade de rede devem ser dimensionados sem NAT desnecessario.
- S3 cobra armazenamento, requisicoes e transferencia conforme o plano da conta.
- API Gateway, Lambda e CloudWatch podem ter franquias gratuitas, mas nao sao ilimitados.
- Secrets Manager e recursos adicionais podem gerar cobranca fixa.

O usuario precisa aprovar explicitamente os recursos, limites de custo e a execucao antes de provisionamento. Esta auditoria nao executa deploy, migration, alteracao de dados ou criacao de recursos.

## Pendencias para iniciar a implementacao

1. Confirmar aprovacao do modelo AWS e da data de migracao.
2. Configurar no ambiente uma sessao AWS segura e valida; a sessao foi validada em `sa-east-1` pela identidade da conta AWS, e nenhuma credencial foi gravada no repositorio.
3. Confirmar se Cognito sera usado ou se o Supabase Auth sera mantido temporariamente.
4. Confirmar volume estimado de dados, quantidade de usuarios e recursos existentes no Supabase.
5. Confirmar dominio e origens CORS oficiais.
6. Confirmar limite mensal de custos e contatos para alertas.
7. Fazer backup do Supabase antes de migrations ou migracao de objetos.
