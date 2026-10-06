# Subir no GitHub sem VS Code

Você não precisa do VS Code.

## Pelo site do GitHub

1. Crie um repositório vazio no GitHub.
2. Abra o repositório e clique em **Add file > Upload files**.
3. Extraia `EXTERNAL-REMOTE-COMPLETE.zip` no seu computador.
4. Abra a pasta `EXTERNAL-REMOTE-COMPLETE` extraída.
5. Arraste **o conteúdo de dentro da pasta** para a página de upload do GitHub.
6. Aguarde todos os arquivos terminarem de carregar.
7. Escreva uma mensagem como `Initial EXTERNAL Remote server` e clique em **Commit changes**.

Não envie um `.env` com senha real. O repositório inclui apenas `.env.example`.

## Estrutura principal

- `server.js` — servidor HTTP/API
- `database.js` — persistência SQLite
- `seed-config.json` — configuração inicial
- `public/index.html` — painel administrativo
- `deploy/` — exemplos para systemd e Nginx
- `scripts/` — backup e restore

## Rodar no servidor

Copie `.env.example` para `.env`, configure as credenciais e execute:

```bash
npm start
```
