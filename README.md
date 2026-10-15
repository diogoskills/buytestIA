# Forma Premium

Loja com fluxo Premium reutilizável: **Supabase Auth → Checkout Pro (Preferences) → confirmação financeira → código por e-mail → ativação**. Anual de R$40 e vitalício de R$120, ambos por pagamento único. O catálogo de produtos físicos continua demonstrativo; a integração financeira cobre o Plano Premium.

Stack: Node.js 24, Express, PostgreSQL/Supabase, Supabase JS para Auth e APIs HTTPS do Mercado Pago e Resend. Sem chaves privadas no navegador. Não há dependência de Edge Functions nem publicação automática da API via integração GitHub/Supabase.

## Desenvolvimento

```sh
npm ci
npm run build
npm test
```

Os testes padrão usam PostgreSQL via PGlite com provedores simulados, sem credenciais. Para testar locks com várias conexões, use um PostgreSQL descartável local (o nome deve começar por `forma_test_`):

```sh
TEST_DATABASE_URL=postgresql://usuario:senha@127.0.0.1:5432/forma_test_local npm test
```

**Essa suíte recria os schemas `billing` e `auth` somente nesse banco de teste. Nunca aponte para seu banco real.** CI cria um banco descartável separado. Para testar a interface:

```sh
npx playwright install chromium
npm run test:browser
# Em um ambiente com Chromium já instalado:
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
```

Para executar a integração real, copie `.env.example` para `.env` (ignorado pelo Git) e preencha os segredos no ambiente de execução. Com banco/autenticação configurados:

```sh
npm run migrate
npm run build
npm start
# Em outro processo, com o mesmo ambiente:
npm run worker
```

O checkout exige `APP_ORIGIN` HTTPS acessível ao Mercado Pago; localhost serve para desenvolvimento de interface e Auth. Os processos API e worker reiniciam separadamente. Uma página HTML servida sozinha não executa o fluxo financeiro.

## Configuração e operação

- [Guia: onde encontrar cada configuração e publicar sem hospedagem existente](docs/SETUP.md)
- [Arquitetura, contratos, segurança e regras dos planos](docs/FLOW.md)
- [Retentativas, suporte e recuperação de falhas](docs/OPERATIONS.md)
- [Fontes oficiais e validação pendente com provedores](docs/SOURCES.md)

Arquivos de entrada: `server/app.js`, `server/billing.js`, `server/jobs.js`, `server/auth.js`; migrations em `supabase/migrations/`; interface em `web/premium.js` e `index.html`.

Para outro projeto, reutilize o backend, configure outro produto/catálogo e implante com **seu próprio banco Supabase, segredos, origem e conta de recebimento**. Este primeiro padrão é isolado por implantação; não é um serviço compartilhado de licenças globais. Toda autorização exige usuário, produto e concessão válida.

## Limites de entrega

Os testes com provedores simulados não comprovam recebimento por uma conta Mercado Pago real, entrega na caixa de entrada nem callbacks do Supabase hospedado. Antes de produção, é necessário concluir a configuração externa e o roteiro sandbox de `docs/SETUP.md`. Não exponha segredos no Git/chat, não habilite cobranças reais para experimentar e não considere a integração GitHub como publicação do site, API, worker ou SMTP.
