# Evidências desta entrega

Validação local em 15/10/2026. Não equivale a deploy nem a uma compra sandbox nos provedores hospedados.

| Verificação | Resultado |
|---|---|
| Instalação pelo lockfile (`npm ci`) e build | Passaram; assets gerados em `dist/`, fora do Git |
| `npm test`, PGlite/PostgreSQL incorporado | 39 passaram, zero falhas, zero skipped |
| Mesma suíte com pool PostgreSQL local (18.4) | 39 passaram, incluindo concorrência de checkout, webhook/pagamento, resgate e reembolso |
| `npm run test:browser`, Chromium | Passou o fluxo de login solicitado, planos R$40/R$120, checkout, pagamento simulado, código, ativação e novo carregamento com acesso ativo |
| Layout e modais | Testados em 320, 390 e 1440 px; fechamento por Esc/clique externo; sem erros de JavaScript |
| Migrations finais, banco PostgreSQL descartável | Primeira aplicação bem-sucedida; segunda execução pulou ambas as versões já registradas |
| CLI de preços, banco descartável | Criou versão 2 com preço novo; pedido anterior permaneceu com snapshot de R$40 |
| `npm audit`, incluindo desenvolvimento | Zero vulnerabilidades reportadas na execução |
| `npm run check` e `git diff --check` | Passaram |

Os testes de concorrência usam várias conexões quando `TEST_DATABASE_URL` aponta para o PostgreSQL local. Alguns cenários de worker são isolados em fixtures PGlite para não modificar o banco da suíte principal. O CI foi adicionado com PostgreSQL 17 e Chromium; sua execução no GitHub não foi consultada nesta validação local.

Testes de Auth exercitam o SDK real Supabase com transporte simulado. Testes de pagamentos e e-mail usam adaptadores falsos determinísticos. O teste de navegador encaminha a origem reservada `https://shop.example` à API local de teste, sem tráfego aos provedores nem desativar verificação TLS externa. Não há modo falso habilitado em `server/index.js` ou no deploy Docker.

Ainda não verificado externamente: callbacks Supabase hospedados, SMTP/domínio de e-mail, compatibilidade e notificações da conta Mercado Pago, criação e pagamento sandbox reais, retorno HTTPS público, entrega em caixa de entrada, deploy web/worker e restauração em nova tarefa de nuvem. Não foram fornecidas as credenciais dessas operações.

## Configuração salva no ambiente do Codex

Foram salvos `install_script` (npm ci/build), `start_skill` (reinício e verificações), requisitos por nome em `environment_variables` e domínios em `network.allowed_domains`. Não foram salvos valores de credenciais. A URL pública do Supabase, identificador do produto e modo `test` são sugestões não secretas.

O rascunho não executa comandos, não aplica a rede em execução, não configura SMTP e não publica a aplicação. Para ativá-lo, revise e salve as alterações em **configurações do ambiente do Codex**, depois publique o ambiente. A hospedagem do site/API/worker é uma etapa distinta, descrita em SETUP.
