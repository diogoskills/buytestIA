# Fluxo, regras e contratos

## Separação das responsabilidades

- `billing.installation`: contexto da implantação, conferido por API e worker no startup; evita alternar testes/produção ou contas recebedoras no mesmo banco.
- `billing.products` e `billing.prices`: configuração confiável e preços versionados. Sem regra de preços no navegador.
- `billing.orders` e `checkout_attempts`: proprietário `auth.users.id`, snapshot contratado (incluindo modo/recebedor), referência UUID opaca, tentativa de criação e retomada.
- `billing.payments`: cada transação do provedor, inclusive pagamentos adicionais reais para o mesmo pedido.
- `billing.events` e `billing.jobs`: recepção durável, filas com leases e retentativas, reconciliação e outbox de e-mails.
- `billing.grants`: direito adquirido com vigência independente do código, ativação e eventual revogação.
- `billing.activation_challenges`: verificador HMAC, expiração, tentativas e consumo atômico.
- `auth_flows`, `sessions` e `rate_limits`: PKCE, sessão opaca com tokens cifrados e limitação persistida. Não substituem o cadastro de usuários do Supabase.

Não há acesso global por conta. Cada pedido, concessão e autorização contém produto. A configuração atual publica somente `forma-premium`. O padrão inicial pressupõe **uma instalação independente por projeto**, com próprio banco e secrets. Não aponte dois projetos independentes para a mesma fila usando segredos/contas diferentes. Compartilhar um banco/fila entre instalações exige outra camada de roteamento de tenant/provedor, fora desta versão.

## Identidade e intenção de compra

O formulário solicita e-mail e escolhe um plano. O servidor gera PKCE pelo SDK oficial do Supabase, grava intenção por uma hora e vincula o callback ao cookie HttpOnly do navegador. O provedor envia Magic Link pelo SMTP configurado.

`/auth/callback` troca o auth code com o verificador PKCE, exige e-mail confirmado e compara seu hash à identidade que iniciou o fluxo. Retorno arbitrário, UUID do cliente e e-mail do pagador não comprovam identidade. A API utiliza `auth.getUser` a cada rota protegida; tokens expirados são renovados sob lock de sessão. Sessões próprias guardam apenas identificador opaco no cookie e tokens Supabase criptografados no banco. Não criam outro usuário/senha.

O link só funciona no navegador que iniciou o pedido. O mesmo usuário pode recuperar acesso em outro dispositivo iniciando novo login lá. Novos logins consultam as concessões existentes; o código original não precisa ser reutilizado.

## Compra, idempotência e Preferences

`POST /api/checkout` exige sessão, Origin/CSRF, `Idempotency-Key` UUID e corpo `{productId, plan}`. Campos de preço, e-mail proprietário, usuário ou premium enviados pelo cliente são recusados. Um lock transacional por usuário/produto serializa a seleção de pedido. O pedido é persistido **antes** de chamar o Mercado Pago; a chave por usuário é única. Chaves novas de cliques paralelos também retomam a compra pendente daquele produto.

A modalidade é **Checkout Pro com Preferences**. Valor em centavos é convertido explicitamente para `unit_price` em reais. `external_reference` contém somente o UUID do pedido. As chaves da API Payments e exemplos da Orders API não são intercambiáveis com esse contrato.

O POST de Preferences não tem sua segurança de idempotência presumida a partir de outro endpoint. Uma única tentativa é emitida por pedido. Resposta interrompida marca `unknown`: não há POST automático repetido. O worker busca Preferences por referência, exige exatamente um resultado, recebedor/ambiente/itens/valor/moeda/expiração coerentes e persiste o ID/URL verificados. Se a preferência continuar invisível ou houver múltiplas, mantém o resultado desconhecido/em análise. A existência de pagamento é pesquisada separadamente. O usuário pode retomar a URL persistida sem novo e-mail.

Uma preferência conhecida expira após sete dias. Pagamentos podem permanecer pendentes ou ser confirmados depois; confirmação tardia ainda usa a data financeira real. Cancelado/recusado permite nova tentativa de compra, mas uma transação antiga que posteriormente aprove também será registrada. Nunca descarte dinheiro do histórico.

## Confirmação financeira

O webhook aceita JSON de até 16 KiB e somente tópico `payment`. Valida `x-signature` (`ts`, `v1`), `x-request-id` e `data.id` do query, exigindo coerência com o corpo. O manifesto HMAC-SHA256 é `id:{data.id};request-id:{x-request-id};ts:{ts};`; identificação é normalizada para minúsculas conforme o contrato (IDs Payments são numéricos). A comparação é constante em tempo para strings do mesmo tamanho. Campos duplicados/malformados e assinaturas com mais de 15 minutos de diferença são recusados; relógios do servidor precisam estar sincronizados. Assinatura rejeitada por atraso não libera acesso; reconciliação recupera o estado pela API.

Evento e tarefa são gravados na mesma transação **antes do HTTP 200**. Falha de banco retorna erro; não há tarefa em memória como única garantia. O processamento ocorre fora da requisição HTTP. Uma entrega duplicada não apaga tentativas anteriores e reabre uma tarefa esgotada. Cada worker usa lease, `SKIP LOCKED` e chaves únicas.

O worker consulta GET autenticado `/v1/payments/{id}` em URL fixa. Confere ID, pedido, recebedor configurado, `live_mode`, moeda e centavos. Apenas `approved` concede direito. `pending`, `in_process`, `authorized`, recusa e cancelamento não concedem. Assinatura válida sozinha ou retorno de sucesso do navegador não conferem acesso.

Consultas financeiras do mesmo pagamento são serializadas sob advisory lock; a API é consultada dentro desse lock. Histórico aprovado não regride para pendência. Reembolso/contestação/análise são conservadores e não voltam a aprovado automaticamente por um evento antigo. Um pagamento só pode ter uma concessão e um pedido só tem uma transação canônica. Pagamentos reais adicionais são preservados, sinalizados e não geram outra concessão para o mesmo pedido.

## Vigência e ativação

**Anual:** 12 meses de calendário desde `date_approved` da API. Fim de mês segue aritmética PostgreSQL (29/02 + 12 meses termina em 28/02). Renovação antecipada permitida apenas nos últimos 30 dias; o novo período começa no maior entre a data de aprovação e o fim do último período anual não revogado. Isso preserva dias restantes. Ativação tardia nunca desloca o início/fim e um período já encerrado não pode ser ativado.

**Vitalício:** pagamento único, sem expiração programada, para o snapshot das funcionalidades do produto adquirido. Migração do anual para vitalício cobra o preço integral do vitalício, sem crédito ou reembolso automático do anual. O direito anual anterior permanece registrado; se o vitalício for revogado, um anual ainda vigente/ativado pode continuar valendo. Quem já adquiriu vitalício não compra novamente o mesmo produto, mesmo antes de ativar. Se duas cobranças reais escaparem dessa janela, a adicional fica sinalizada para suporte, sem acesso duplicado.

Após aprovação, concessão e e-mail são criados transacionalmente. O código contém 12 bytes criptograficamente aleatórios em 24 caracteres hexadecimais. Só um HMAC que inclui challenge, concessão, usuário e produto é guardado como verificador. A outbox carrega cópia **cifrada AES-256-GCM**, necessária para retentar o envio; nunca código em texto puro. O conteúdo cifrado é removido após o job concluir. Códigos e tokens nunca são escritos nos logs da aplicação.

Código dura 15 minutos, aceita cinco tentativas e só pode ser consumido uma vez. Falhas de tentativa são persistidas mesmo quando o resgate retorna erro. Reenvio exige sessão do proprietário, compra aprovada, direito não revogado/não expirado, intervalo mínimo de 60 segundos e limite de cinco solicitações por hora. Invalida o desafio anterior e cria o novo com outbox na mesma transação. Resgate usa lock da concessão e do desafio; outra conta ou outro produto não consegue resgatar.

Código é confirmação de ativação de uma compra vinculada à conta, não licença compartilhável. Confirmar o mesmo e-mail novamente não é um segundo fator independente. A compra continua recuperável se o código ou seu e-mail expirar.

## Autorização e reversões

`access()` centraliza usuário/produto, estado financeiro aprovado, ativação, revogação, início e expiração. `requireAccess()` é a guarda obrigatória para qualquer endpoint Premium novo; permite exigir também uma funcionalidade do snapshot. `/api/premium/benefits` é um exemplo funcional protegido. A interface consulta o resultado para exibição e não decide autorização no servidor.

Reembolso total revoga a concessão correspondente. Qualquer reembolso parcial, contestação ou `in_mediation` suspende o direito e exige revisão assistida. Não há restauração automática por outra notificação `approved`. Reembolsos efetivos são feitos pelo operador na ferramenta oficial do provedor; a aplicação não dispara devoluções ou cobranças adicionais. Uma renovação previamente adquirida que ficou com período futuro após estorno do período anterior exige análise: datas não são deslocadas silenciosamente.

## Controles da superfície web

Cookies de fluxo/sessão/CSRF são HttpOnly, SameSite=Lax e Secure em HTTPS. Mutações da aplicação exigem Origin exata e token CSRF ligado ao cookie. Não há CORS permissivo. Redirecionamento de Auth é fixo; checkout só aceita host HTTPS brasileiro do Mercado Pago permitido. Arquivos `.env`, migrations e código do servidor não são servidos estaticamente. CSP restringe execução e conexão à mesma origem.

Abuso é limitado no banco por IP e conta/e-mail hasheado. Não se confia automaticamente em `X-Forwarded-For`; em hospedagem com proxy, configure `TRUST_PROXY_CIDRS` com os endereços oficiais do ingresso. Sem isso, os limites são agregados pelo IP do proxy. Nunca use `true` ou CIDR global para confiar em cabeçalhos arbitrários.

Dados de pagamento completos e payloads de webhook não são retidos; somente IDs, estados e valores necessários. Dados operacionais concluídos de eventos/jobs são limpos após 30 dias; fluxos de Auth expirados e sessões vencidas são removidos. Pedidos, pagamentos e direitos permanecem para suporte/obrigações financeiras. Defina uma política legal de retenção e anonimização apropriada antes de produção.
