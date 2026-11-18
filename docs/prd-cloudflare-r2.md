# PRD — Armazenamento Cloudflare R2 no MeuDrive

## Objetivo

Usar Cloudflare R2 como destino padrão de novos arquivos, mantendo Supabase Auth e PostgreSQL. Os objetos permanecem privados; o navegador recebe somente URLs pré-assinadas de curta duração. Arquivos já presentes no Supabase Storage continuam acessíveis durante a migração gradual.

## Auditoria do estado atual

- Front-end: React 19, TypeScript, Vite 8.
- Backend: Supabase Edge Functions; atualmente `manage-users`.
- Banco/autenticação: Supabase PostgreSQL e Auth.
- Armazenamento: Supabase Storage é usado para listagem recursiva, upload direto/TUS, download, prévia, substituição e exclusão.
- Metadados: não há tabela de arquivos. A listagem é derivada de `storage.objects`; `user_profiles` contém papéis. Pastas são implícitas nos caminhos.
- Cache: IndexedDB guarda catálogo e blobs baixados por usuário/bucket; não é sincronização de pasta local.
- Acesso: colaboradores ficam limitados aos próprios caminhos; gerente/Master podem acessar arquivos de todos. RLS existente protege Storage e perfis.

## Arquitetura desejada

1. Supabase Auth identifica o usuário; cada Edge Function valida o token com `auth.getUser()`.
2. PostgreSQL guarda somente metadados, status e sessões multipart.
3. Edge Function usa credenciais R2 no servidor para criar multipart, listar partes, assinar URLs, finalizar e excluir objetos.
4. Navegador envia cada parte diretamente ao R2; padrão inicial de 100 MiB e concorrência limitada.
5. Catálogo R2 vem do PostgreSQL. Objetos antigos continuam listados/lidos pelo provedor Supabase.
6. Chaves R2 são UUIDs sob um prefixo do usuário; nomes e caminhos apresentados são metadados.

## Requisitos funcionais

- Upload multipart com progresso real por parte, retomada por `ListParts`, novas URLs quando expiram e confirmação de integridade antes do status concluído.
- Upload interrompido não é concluído nem remove partes; após re-selecionar o arquivo, tamanho, caminho, data de modificação e impressão digital parcial precisam corresponder.
- Listar metadados sem baixar conteúdo; URLs assinadas somente para abrir/baixar.
- Exclusão autorizada no servidor; renomear/mover altera metadados sem copiar o objeto.
- RLS restringe leitura dos metadados por usuário e preserva acesso de gerente/Master.
- Falhas após completar no R2 devem permitir reconciliação sem apagar objetos válidos.
- R2 é privado; CORS permite `PUT` e expõe `ETag` somente aos domínios do app.

## Compatibilidade e migração

- Nenhum objeto ou política do Supabase Storage é removido por esta migração.
- Novos uploads usam R2; o catálogo une os metadados R2 com objetos legados do Supabase.
- Registros carregam `storage_provider` para direcionar leitura e exclusão.
- Migração de objetos antigos é uma etapa posterior, explícita e verificável; nunca copiar/apagar automaticamente.

## Segurança e operação

- Segredos R2 somente como secrets da Edge Function.
- Identidade e papéis vêm da sessão validada e de `user_profiles`, nunca de `user_id` enviado pelo cliente.
- URLs temporárias têm validade curta e não substituem autorização da função.
- Limite de upload segue os limites do R2 multipart (até 5 TiB por objeto e no máximo 10.000 partes); quota comercial configurável é separada da capacidade técnica.
- Uploads abandonados devem ser cancelados por uma rotina agendada após prazo configurado. Reconciliação deve tratar objetos sem registro e registros sem objeto sem apagar conteúdo automaticamente.

## Critérios de aceite e plano

1. **Fundação:** migration revisável, RLS, Edge Function segura e configuração/documentação.
2. **Upload:** arquivo >10 GB pelo navegador, multipart, retomada por ListParts, URLs renováveis, progresso real e conclusão após `HeadObject`.
3. **Catálogo e operações:** listagem paginada, preview/download assinado, excluir, renomear e mover.
4. **Compatibilidade:** leitura de objetos Supabase existentes e migração gradual auditável.
5. **Operação:** limpeza agendada, reconciliação, quota/alertas e métricas.
6. **Validação:** testes com arquivos de 1 MB, 50 MB, 500 MB, 1, 5, 10 e 20 GB, falhas/retomada/permissões e navegadores Chromium, Firefox e Safari.

## Limitações de validação

O workspace não contém credenciais R2 nem acesso operacional ao projeto Supabase/Cloudflare. Portanto, migrations não devem ser aplicadas automaticamente e testes reais de integração, navegadores e arquivos de 10/20 GB precisam ser executados no ambiente configurado. A franquia gratuita do R2 não representa armazenamento ilimitado.

## Status da implementação nesta entrega

Implementado no código: migration de catálogo/sessões com RLS e Realtime; Edge Function autenticada para iniciar/listar/finalizar/cancelar multipart, renovar URLs de parte, assinar leitura, excluir, alterar caminho, reconciliar por sessão e limpar sessões expiradas sob demanda; upload direto browser→R2 com até 3 partes em paralelo, retries, pausa/reseleção e progresso de bytes/velocidade/estimativa; leitura combinada do catálogo R2 com objetos legados; download/preview por URL assinada e compatibilidade de exclusão/substituição/movimentação legado.

Ainda pendente para o aceite completo: concorrência entre arquivos (os arquivos de um lote são processados em série), estados e cancelamento individual por arquivo na fila, agendamento real da limpeza de sessões, varredura/reconciliação de objetos sem registro, cotas/alertas/limites e medição de consumo R2, migração automatizada do legado e testes reais de integração/navegadores até 20 GB. O fingerprint de retomada verifica metadados e amostras de até 1 MiB no começo/fim, não é hash integral. A migration foi criada, mas não aplicada a nenhum banco.
