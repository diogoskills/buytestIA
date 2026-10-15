# Configurar e publicar

## 1. Supabase que você já criou

URL pública informada: `https://lbbdwjgwjpymfysblsbj.supabase.co`. O sufixo `/rest/v1/` é a Data API, não a URL base usada na configuração.

| Variável | Onde encontrar / configurar |
|---|---|
| `SUPABASE_URL` | Settings → Data API → Project URL, ou Connect → Framework |
| `SUPABASE_PUBLISHABLE_KEY` | Settings → API Keys → Publishable key; o backend também aceita a chave legada `anon` |
| `DATABASE_URL` | Connect → Connection string → Session pooler, com a senha do banco substituída no campo privado da hospedagem |
| `APP_ORIGIN` | URL HTTPS do serviço web publicado, sem barra final, caminho ou query string |

A API usa conexão PostgreSQL privilegiada exclusivamente no servidor. A senha do banco não é a senha de login do painel. Se precisar redefini-la, use Settings → Database e atualize o segredo dos dois serviços. Use o **Session pooler** para compatibilidade com hosts IPv4 e transações; não use o modo Transaction com essa configuração de migração/locks. Preserve TLS com `sslmode=verify-full` e, quando necessário, o certificado CA oficial baixado no painel. O parâmetro `sslrootcert` na conexão pode apontar para o arquivo CA montado como segredo. Não desative a verificação TLS.

Não é preciso criar um sistema próprio de usuários nem fornecer `service_role`: identidade vem de Supabase Auth, e envio de código consulta o e-mail confirmado em `auth.users` pela conexão do backend.

## 2. Ambientes e migrations

Use projetos Supabase/bancos **separados para homologação e produção**. No primeiro startup, API e worker registram uma vinculação imutável por configuração a produto, projeto Supabase, modo Mercado Pago e recebedor. Uma mudança incompatível bloqueia o startup; não edite esse registro para transformar direitos de teste em direitos reais. O projeto informado pode ser usado primeiro para homologação. Configure outro projeto para produção ou escolha um projeto de homologação separado antes da primeira execução. Nenhuma vinculação remota foi criada nesta entrega.


Há duas migrations aditivas: schema `billing` e preços iniciais. Nenhuma tabela de outro projeto é alterada. A aplicação bloqueia acesso direto do navegador a todas as tabelas de billing com RLS e revogação de privilégios.

Você já conectou o GitHub. O diretório de trabalho é `.` (a pasta `supabase/` fica na raiz) e a branch atual é `work`. Mantenha deployment automático de produção desligado durante a validação. Escolha **um único executor de migrations por implantação**, sem executar dois ao mesmo tempo:

- integração Supabase/GitHub, revisando os logs de implantação das migrations; ou
- `npm run migrate` com `DATABASE_URL` no ambiente, uma vez por release.

O comando usa o histórico `supabase_migrations.schema_migrations` compatível com o CLI, pula versões já aplicadas e não apaga dados. Não edite uma migration já aplicada; crie outra. Verifique que esta é a instância pretendida antes de rodar comandos. Não execute `db reset` em banco real. Após testes em instância separada, promova as migrations para produção pelo mecanismo escolhido.

Se já houver outro schema `billing` no banco escolhido, pare e revise a colisão; não apague/recrie tabelas existentes para aplicar este padrão.

O schema `billing` deve permanecer fora da lista de schemas expostos pela Data API. A UI só consulta `/api/account`, que filtra o proprietário autenticado. Preços iniciais: anual **4000 centavos**, vitalício **12000 centavos**. Para alterar depois, no ambiente seguro:

```sh
npm run price -- forma-premium annual 5000
```

Isso cria nova versão e preserva pedidos anteriores. É configuração financeira: revise antes de executar em produção.

## 3. Hospedagem do site/API e do worker

Uma opção é Render com **um serviço Web** e **um Background Worker**. `render.yaml` e `Dockerfile` estão preparados para revisão; criar serviços pode ter custo. Nada é contratado ou publicado ao salvar esses arquivos.

1. Crie uma conta na hospedagem e conecte `diogoskills/buytestIA`, branch `work`.
2. Crie um Web Service com o Dockerfile do repositório. O comando padrão executa `server/index.js`. Health check: `/health`.
3. Crie um Background Worker com o mesmo Dockerfile, comando `node server/worker.js`. Ele precisa permanecer ativo.
4. Cadastre o grupo de ambiente `forma-premium` com todas as variáveis de `.env.example`, compartilhado pelos dois serviços. No Render, as variáveis ficam em Environment; credenciais devem ser valores privados. Não cole valores neste documento ou no chat.
5. Ao obter a URL do Web Service, use-a como `APP_ORIGIN` nos dois serviços. Um domínio próprio é opcional para hospedar a aplicação; e-mail de produção exige domínio de envio verificado.
6. Configure `TRUST_PROXY_CIDRS` somente com os IPs/CIDRs de ingresso documentados pela hospedagem; sem isso, os limites por IP serão agregados no proxy. Não confie em qualquer `X-Forwarded-For`.
7. Aplique as migrations pelo executor escolhido. Reinicie os dois serviços após configurar os valores. Valide `/health`, carregamento dos planos e recuperação de sessão.

Não hospede isso apenas no GitHub Pages: a API, conexão com o banco e worker precisam de execução de servidor. Uma alternativa é qualquer plataforma com Docker, HTTPS e dois processos supervisionados. O Docker não executa migrations automaticamente durante o build nem no startup.

## 4. Supabase Auth e SMTP de produção

Em Authentication → URL Configuration:

- **Site URL** = `APP_ORIGIN`.
- **Redirect URL permitida** = `APP_ORIGIN/auth/callback`, exatamente.

O backend cria um fluxo PKCE, armazena intenção de plano no banco e exige o cookie de início no callback. Use o template padrão de Magic Link com `{{ .ConfirmationURL }}`; não o substitua por um link arbitrário para o site e não converta para OTP digitável sem adaptar o fluxo. O link deve abrir **no mesmo navegador em que foi solicitado**. Para outro dispositivo, peça um novo link nele. Só o link mais recente do mesmo navegador será utilizável.

Configure **Custom SMTP** em Authentication → Email / SMTP Settings, usando Resend ou outro provedor transacional. Com Resend, use o host, porta e login mostrados no painel SMTP deles; a API Key deve ser cadastrada somente no campo de senha do Supabase. Configure remetente do domínio verificado. O envio padrão de teste do Supabase não serve como infraestrutura de produção.

Habilite limites de envio apropriados no Supabase Auth e proteção CAPTCHA conforme seu tráfego. A API implementa limites persistidos por IP e hash de e-mail e aceita `captchaToken` opcional para integração própria; a UI atual não embute um widget CAPTCHA. Não torne CAPTCHA obrigatório antes de integrar seu widget, pois os pedidos de login seriam recusados. A resposta de envio é genérica para evitar enumeração de contas; monitore falhas reais no painel de Auth/SMTP.

## 5. Resend para códigos de ativação

No Resend:

1. Domains → Add domain/subdomain que você controla. Publique os registros **DKIM e SPF** fornecidos; configure **DMARC** de acordo com a política do seu domínio. Aguarde verificação. Não invente registros DNS.
2. API Keys → crie uma chave de envio limitada ao domínio verificado e cadastre como `RESEND_API_KEY` nos dois serviços.
3. `EMAIL_FROM` deve conter um remetente autorizado, por exemplo `Forma <acesso@seu-dominio.com.br>`.
4. Configure alertas para bounce/complaint no dashboard do provedor. A API aceitar o envio não significa entrega na caixa de entrada.

A outbox registra o ID do e-mail aceito. Falhas de API têm retentativas; código expirado pode ser reenviado sem perder a compra. Bounces e bloqueios após aceitação devem ser investigados no Resend; não há endpoint local que receba eventos de entrega do Resend nesta versão. Para email incorreto após pagamento, use recuperação assistida documentada em OPERATIONS.

## 6. Mercado Pago — somente sandbox primeiro

Em Mercado Pago Developers → Suas integrações, selecione/crie aplicação **Checkout Pro** compatível com sua conta brasileira. Este código utiliza **POST `/checkout/preferences` + GET `/v1/payments/{id}`**, não Orders API, Bricks nem assinaturas recorrentes. O anual é uma compra única.

- `MP_ACCESS_TOKEN`: credencial de **teste** da aplicação/conta de vendedor de teste compatível com Checkout Pro.
- `MP_MODE=test`: seleciona `sandbox_init_point` e exige `live_mode=false` nas transações.
- `MP_COLLECTOR_ID`: ID da conta recebedora correspondente ao token. Pode ser confirmado por GET autenticado `/users/me`; use um terminal seguro ou o console oficial, sem copiar a resposta inteira para logs/chat.
- Em Webhooks, configure **pagamentos (`payment`)**. URL de teste e depois produção: `APP_ORIGIN/api/webhooks/mercadopago`. Não habilite tópicos de outras APIs neste endpoint.
- `MP_WEBHOOK_SECRET`: assinatura secreta exibida na configuração de Webhooks, cadastrada apenas no servidor.

As URLs de retorno success/pending/failure são `APP_ORIGIN/?premium=1`. Elas só mostram o estado consultado no servidor. O e-mail do pagador no Mercado Pago não muda a conta proprietária da compra. A conta deve permitir produtos digitais/serviços e a modalidade proposta; valide isso antes de produção.

O endpoint de Preferences não é tratado como se possuísse a garantia de `X-Idempotency-Key` do endpoint Payments. Locks, pedido durável e chave de requisição local impedem POST duplicado. Se houver timeout, o worker pesquisa Preferences pela referência opaca e só recupera uma preferência única e conferida; ausência no resultado não autoriza recriação automática. Nenhuma URL arbitrária do webhook é consultada.

## 7. Segredos internos

`DATA_ENCRYPTION_KEY` e `ACTIVATION_HMAC_KEY` são **independentes**, cada uma com 32 bytes aleatórios representados em 64 caracteres hexadecimais. Gere-os com um gerenciador de segredos ou gerador criptográfico no seu terminal seguro. Preserve os valores entre deploys e nos dois processos. São necessários como valores reais no processo, não placeholders de proxy HTTPS. A URL do banco também precisa funcionar como conexão PostgreSQL real.

Não rotacione a chave de criptografia sem recriptografar sessões/outbox ou encerrar as sessões e reemitir os códigos pendentes. Uma perda da chave não apaga os direitos comprados, mas exige recuperação operacional. Credenciais Mercado Pago e Resend saem apenas por HTTPS aos respectivos hosts.

## 8. Roteiro sandbox obrigatório antes de produção

1. Verifique migrations aplicadas, API saudável e worker processando a fila.
2. Peça um link de Auth, confirme e-mail real de teste e retome o plano escolhido no mesmo navegador. Confirme login também em outro dispositivo iniciando novo link.
3. Abra Checkout Pro e pague com comprador/cartão de teste conforme os dados atuais do painel Mercado Pago. **Não use dinheiro real.** Teste pendente, recusa e aprovação.
4. Feche a aba antes do retorno; o webhook/reconciliação deve registrar a compra sem depender do retorno.
5. Confira código aceito pelo Resend, entrega no e-mail confirmado, ativação e acesso recuperado ao entrar novamente.
6. Reenvie código, tente código anterior, outra conta, repetição e expiração. Confirme bloqueios.
7. Simule falha de e-mail/worker e retentativa. Teste reembolso total/parcial e contestação, confirmando suspensão no endpoint premium.
8. Verifique assinatura real e cabeçalhos do Mercado Pago. A suíte local usa o manifesto de assinatura de `payment`; não substitui uma notificação real da conta selecionada.
9. Só depois revise preço e habilite credenciais reais, `MP_MODE=live`, recebedor, webhook de produção, SMTP e monitoramento.

Sem essas validações externas, a entrega é uma implementação testada localmente, **não um checkout publicado ou pronto para cobrar em produção**.
