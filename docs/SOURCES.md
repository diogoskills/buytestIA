# Referências oficiais e escopo da validação

Contrato selecionado: **Checkout Pro com Preferences**; notificações `payment`; confirmação por Payments API. Não há mistura com Orders API, assinaturas recorrentes ou Bricks.

Referências oficiais para configuração e conferência sandbox:

- [Checkout Pro / criar preferência](https://www.mercadopago.com.br/developers/pt/reference/preferences/_checkout_preferences/post)
- [Notificações e assinatura de Webhooks](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/notifications/webhooks)
- [Consultar pagamento](https://www.mercadopago.com.br/developers/pt/reference/payments/_payments_id/get)
- [Supabase: Magic Link e configuração de redirecionamento](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Supabase: PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Supabase: SMTP customizado](https://supabase.com/docs/guides/auth/auth-smtp)
- [Resend: idempotência](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Resend: domínio de envio](https://resend.com/docs/dashboard/domains/introduction)

Durante a implementação, a rede do ambiente negou acesso direto aos sites de documentação. Foi possível consultar os **repositórios oficiais atuais** pelo GitHub, incluindo:

- [Documentação fonte do Supabase: passwordless](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/auth-email-passwordless.mdx)
- [Documentação fonte do Supabase: PKCE](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/sessions/pkce-flow.mdx)
- [SDK oficial Mercado Pago: criar preferência](https://github.com/mercadopago/sdk-nodejs/blob/master/src/clients/preference/create/index.ts)
- [SDK oficial Mercado Pago: pesquisar preferências e filtros](https://github.com/mercadopago/sdk-nodejs/blob/master/src/clients/preference/search/types.ts)
- [SDK oficial Mercado Pago: buscar pagamento](https://github.com/mercadopago/sdk-nodejs/blob/master/src/clients/payment/get/index.ts)
- [SDK oficial Resend: enviar e-mail](https://github.com/resend/resend-node/blob/main/src/emails/emails.ts)
- [Supabase CLI: contrato do histórico de migrations](https://github.com/supabase/cli/blob/develop/apps/cli-go/pkg/migration/history.go)

O SDK Supabase instalado também foi exercitado diretamente em testes PKCE com transporte simulado. Os demais adaptadores são chamadas HTTPS aos endpoints fixos documentados, sem SDK extra.

A assinatura HMAC, o formato de Preferences, a compatibilidade da conta, a escolha de credenciais de teste e a entrega de e-mail **ainda exigem validação sandbox real**, seguindo SETUP. Não foram recebidas credenciais de acesso aos provedores nem hospedagem HTTPS. Nenhum pagamento real foi criado, nenhum banco Supabase remoto foi migrado por comandos locais e nenhum deploy foi realizado por esta implementação.

Os domínios de documentação/API necessários foram adicionados ao rascunho de configuração do ambiente; salvar o rascunho não aplica a rede em execução nem publica a aplicação. Para testes externos, também serão necessários os hosts específicos do banco/pooler do Supabase escolhido e a origem pública da hospedagem.
