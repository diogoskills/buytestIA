# Operação e recuperação

## Processos e monitoramento

API: `npm start`. Worker: `npm run worker`. Ambos exigem o mesmo banco, criptografia/HMAC, produto e configuração do provedor. API sem worker não conclui pagamento/e-mail; worker sem API não recebe novas compras/webhooks. `/health` verifica conectividade com o banco; não é um teste de pagamento nem de entrega de e-mail.

O worker consulta a fila a cada cinco segundos, processa no máximo dez jobs por lote e agenda até vinte pedidos por varredura. Reconciliação de pendentes ocorre a cada 15 minutos; aprovados, diariamente. A janela automática é 180 dias desde a criação do pedido; notificações assinadas continuam aceitas além dela. Pedidos antigos saem do índice de reconciliação sem varrer todo o histórico. Casos anteriores à janela requerem consulta assistida no provedor. Pesquisa de transações pagina em lotes de 50, até 1000 resultados por pedido; excesso exige revisão.

Retentativas de job: até dez, atraso exponencial de 30 segundos até uma hora. Lease de 90 segundos, recuperado por outro worker após expirar. A chamada ao provedor tem timeout de 12 segundos. A API não retenta POST de preferência automaticamente. O envio de e-mail usa idempotência do Resend por desafio; nunca retenta a mesma chave depois de 23 horas (janela conservadora dentro do período de idempotência do provedor). Códigos de 15 minutos já vencidos não são enviados; proprietário pede um novo.

Uma execução por cron é possível com `node server/worker.js --once`, mas a latência de entrega passa a depender da frequência do cron. Use execução supervisionada contínua quando possível. Não implemente apenas `setTimeout` na requisição do webhook nem confie em processos que sobrevivam a deploy.

Configure alertas para:

- jobs `dead`, lease vencido repetido e atraso dos jobs `pending`;
- `orders.needs_review=true` e pedidos `unknown` persistentes;
- falhas de SMTP/Auth, rejeições/bounces/complaints no Resend;
- webhook recusado, erro de banco e falha de API do Mercado Pago;
- health check e reinícios do worker.

A aplicação não imprime credenciais, código, payload do provedor, e-mail ou tokens. Configure a hospedagem/reverse proxy para não registrar corpos/cookies/cabeçalhos de autorização nem a query de `/auth/callback` (contém auth code temporário). Use somente métricas e identificadores internos na investigação.

## Consultas de diagnóstico

Execute no SQL Editor do projeto correto, com conta de operação autorizada. Não exponha as tabelas operacionais pela Data API.

```sql
select kind,state,count(*) from billing.jobs group by kind,state;
select id,kind,state,attempts,error_code,available_at,lease_until,provider_message_id
from billing.jobs where state in ('pending','running','dead')
order by available_at limit 50;
select id,product_id,financial_status,checkout_status,needs_review,created_at
from billing.orders where needs_review or checkout_status='unknown'
order by created_at desc limit 50;
```

Não consulte/exporte `tokens_cipher`, `verifier_cipher`, verifier de ativação ou payload cifrado de e-mail como parte de relatórios. Registre auditoria restrita de ações assistidas.

## Cenários e próximas ações

| Situação | Comportamento / ação |
|---|---|
| Link de login não chegou | Confirmar e-mail digitado, esperar intervalo, verificar Auth/SMTP e spam. Resposta pública não revela cadastro. |
| Link aberto em outro navegador ou já utilizado | Iniciar novo login nesse navegador. Só o último fluxo do mesmo navegador deve ser usado. |
| Sessão expirou | Entrar novamente; pedidos e direitos pertencem a `auth.users.id`, não ao dispositivo. |
| Usuário fechou a aba / webhook chegou antes do retorno | Worker confirma, preserva direito e envia código. Login recupera o estado. |
| Checkout desconhecido após timeout | Não pagar novamente em outra aba. Worker pesquisa preferência por referência, sem repetir POST. Aguardar ou acionar suporte. |
| Nenhuma preferência encontrada após timeout | Ausência não prova falha do POST. Manter bloqueio e investigar na conta oficial. Sem criação automática de uma segunda cobrança. |
| Mais de uma preferência para o mesmo pedido | Revisão manual. Não escolher aleatoriamente um resultado nem substituir referência/proprietário. |
| Pendência / API indisponível | Estado continua pendente/desconhecido. “Consultar pagamento atualizado” enfileira nova reconciliação com limite de frequência. |
| Pagamento recusado/cancelado | Nova compra pode ser iniciada. Pagamentos antigos que aprovem tardiamente continuam sendo registrados e podem exigir revisão. |
| Webhook ausente ou inválido | Não liberar acesso. Corrigir assinatura/tópico/relógio/URL e deixar reconciliação consultar a API. |
| Valor/moeda/recebedor/ambiente divergentes | Job vai para revisão (`dead` com código de erro), sem concessão. Investigar credenciais e transação no provedor. |
| Código correto não ativa | Confirmar login do proprietário, pagamento e prazo; se expirou, reenviar. Sem pagamento não há acesso. |
| E-mail falhou | Direito permanece. Corrigir envio, pedir novo código na sessão do proprietário; código antigo é invalidado. |
| Bounce após aceitação do Resend | Consultar dashboard pelo `provider_message_id`; corrigir endereço via recuperação assistida e reemitir desafio. `done` significa API aceitou ou tarefa ficou obsoleta, não entrega na caixa de entrada. |
| Dois pagamentos reais para um pedido | Ambos permanecem em `payments`; adicional é `duplicate`, pedido exige revisão. Resolver devolução no painel oficial; não conceder duas vezes nem apagar histórico. |
| Reembolso/contestação | Concessão suspensa; não restaurar só porque frontend informa sucesso ou evento antigo chega. Investigar no provedor. |
| Acesso anual acabou | Servidor nega acesso. Renovação cria novo período com nova confirmação financeira. |

Para recuperar um job após corrigir a causa, o operador pode reenfileirar **um ID específico** sob auditoria:

```sql
-- Substituir somente pelo UUID do job inspecionado. Nunca executar em massa.
update billing.jobs set state='pending',attempts=0,available_at=now(),error_code=null,
 lease_until=null,lease_token=null
where id='UUID-DO-JOB' and state='dead';
```

Não reaproveite jobs de e-mail com código vencido nem payload apagado: solicite reenvio pela conta. Para reconciliação financeira excepcional além de 180 dias, reexecute o job de um pedido inspecionado ou use o mecanismo operacional de enfileiramento com `orderId` existente. Nenhuma operação assistida deve alterar `user_id`, valor, snapshot ou concessão só com base em mensagem do cliente.

## E-mail incorreto e transferência

Antes da compra, o usuário pode corrigir o endereço no formulário ou sair da conta e entrar com o endereço correto. Depois do pagamento, não há endpoint público de transferência por e-mail/UUID. O suporte deve comprovar a identidade original e a transação, seguir o fluxo autenticado de alteração de e-mail do Supabase, auditar a alteração e só então reenviar para o e-mail confirmado atual do **mesmo `auth.users.id`**. Perda de acesso à conta requer procedimento assistido do provedor; o checkout não implementa transferência automática entre usuários.

## Backup, chaves e reutilização

Faça backup do PostgreSQL e mantenha as chaves no gerenciador de segredos da hospedagem. Não copie `.env` para outros projetos. Cada instalação tem produto, chaves e banco próprios. Perda de chave pode exigir expirar sessões, invalidar desafios antigos e emitir novos; não apague os pagamentos/direitos para resolver isso. A rotação planejada de criptografia exige ferramenta de recriptografia fora deste MVP.

Este projeto é web: funcionalidades futuras precisam usar `requireAccess` no servidor. Se o padrão for levado a uma extensão com recursos totalmente locais, as verificações locais poderão ser adulteradas. Esta versão não fornece licença offline, tolerância offline nem proteção absoluta contra cópia.
