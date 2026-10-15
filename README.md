# Cartão de aniversário online

As pessoas assinam com nome, e-mail e um recado opcional. As assinaturas aparecem no cartão
e a página se atualiza sozinha a cada 10 segundos. Quando vocês comprarem o presente, informem a descrição e o valor
em `/admin.html`. O valor por pessoa passa a aparecer no cartão, e o admin gera a mensagem para mandar a todo mundo.

- `/` – cartão público. Os e-mails **não** aparecem aqui.
- `/admin.html` – lista com os e-mails, definição do presente e do rateio, exclusão de assinaturas e mensagem pronta (copiar ou abrir no e-mail com todos em cópia oculta).

## Rodar localmente

```bash
npm install
npm start
```

Abra http://localhost:3000. Sem `DATABASE_URL`, os dados ficam em `data.json`.

## Variáveis de ambiente

| Variável         | Para quê                                                    |
|------------------|-------------------------------------------------------------|
| `ANIVERSARIANTE` | Nome que aparece no título ("Feliz aniversário, Fulana!")   |
| `ADMIN_KEY`      | Senha da página `/admin.html`. **Obrigatório trocar.**      |
| `DATABASE_URL`   | Postgres (recomendado no Render). Sem ela, usa `data.json`. |
| `BREVO_API_KEY`  | Chave de API do Brevo, para enviar o cartão ao aniversariante. |
| `EMAIL_FROM`     | E-mail remetente, verificado no Brevo.                      |
| `EMAIL_FROM_NAME`| Nome do remetente (opcional).                               |

## Visão do aniversariante

No admin, cadastre o e-mail do aniversariante. Ele recebe um e-mail com as mensagens e um link secreto
(`/aniversariante.html?k=...`) para o cartão dele, que mostra só nomes e recados, sem e-mails e sem valores.

O Render gratuito bloqueia o envio por SMTP (Gmail, Outlook), por isso o envio usa a API do **Brevo** (gratuito, 300 e-mails por dia):

1. Crie uma conta em brevo.com.
2. Em *Senders, Domains & Dedicated IPs → Senders*, adicione e confirme o seu e-mail.
3. Em *SMTP & API → API Keys*, gere uma chave.
4. No Render, configure `BREVO_API_KEY` e `EMAIL_FROM`.

Sem essas variáveis, o botão do admin abre o seu próprio cliente de e-mail com o texto e o link prontos.

## Deploy no Render

1. Suba esta pasta para um repositório no GitHub (o `.gitignore` já exclui `node_modules` e `data.json`).
2. **Banco:** no Render, *New → Postgres*, plano Free. Copie a *Internal Database URL*.
3. **App:** *New → Web Service*, conecte o repositório.
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: `ANIVERSARIANTE`, `ADMIN_KEY` e `DATABASE_URL` (a URL do passo 2)
4. Compartilhe a URL `https://<seu-app>.onrender.com` com a galera.

### Por que usar o Postgres

No plano gratuito do Render, o disco do Web Service é **temporário**: ele é apagado a cada deploy, a cada reinício
e quando o serviço "dorme" após uns 15 minutos sem acesso. Sem `DATABASE_URL`, as assinaturas em `data.json` se perdem.
O Postgres gratuito do Render expira em cerca de 30 dias, o que é suficiente para um cartão temporário.
Antes disso, exporte os dados pelo admin (copiar e-mails).

Outra observação: depois de dormir, o primeiro acesso demora uns 30 a 50 segundos para responder. É normal.
