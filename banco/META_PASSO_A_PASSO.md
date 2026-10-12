# Exames de vista + anúncios: o que falta ligar

## 1) Banco de dados (uma vez)
Supabase → SQL Editor → cole todo o arquivo `banco/exames_trafego.sql` → Run.

Depois, para liberar na Óticas DK:
```sql
update oticas set modulos = coalesce(modulos,'{}'::jsonb) || '{"exames":true}' where slug='oticadk';
```
Na aba "Exames de vista" do sistema, preencha endereço, WhatsApp, dias e horários e ative a página.
Confirme também que o WhatsApp Automático está ligado (conector aberto no computador da ótica).

## 2) Conectar a Meta (Facebook/Instagram) - só para a aba Anúncios
1. https://developers.facebook.com → Meus apps → Criar app → tipo "Empresa".
2. Adicione os produtos "Login do Facebook para Empresas" e "API de Marketing".
3. Em Login do Facebook → Configurações → URI de redirecionamento OAuth válido:
   `https://ovynkeifzhavhjdkjjui.supabase.co/functions/v1/meta-conectar`
4. Em Configurações do app → Básico, copie o ID e a Chave secreta.
5. Supabase → Edge Functions → Secrets: crie `META_APP_ID` e `META_APP_SECRET`.
   (Opcional: `ANTHROPIC_API_KEY` para a análise semanal por IA; `SITE_URL`.)
6. Com o app em modo Desenvolvimento, só funcionam contas que são administradoras/testadoras do app
   (suficiente para o piloto na Óticas DK). Para outras óticas será preciso a revisão de permissões da Meta
   (ads_management, ads_read, business_management, pages_show_list, pages_read_engagement, pages_manage_ads, instagram_basic).
7. No sistema: Exames de vista → Anúncios → Conectar. Cada ótica paga os próprios anúncios na conta de anúncios da Meta.

## Observações
- Anúncios passam pela análise da Meta antes de rodar.
- Texto dos anúncios evita falar da condição de quem vê (política de saúde da Meta).
- O agendamento feito pelo link recebe confirmação e lembrete pela fila do WhatsApp automaticamente.
