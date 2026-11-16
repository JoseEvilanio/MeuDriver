from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from matplotlib import pyplot as plt
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, Image, PageBreak

PROJECT_NAME = 'MeuDriver'
OUTPUT_DIR = Path(__file__).resolve().parent
PDF_PATH = OUTPUT_DIR / 'relatorio-auditoria-seguranca.pdf'
SEVERITY_PNG = OUTPUT_DIR / 'severity_donut.png'
CATEGORY_PNG = OUTPUT_DIR / 'category_bars.png'

severity_palette = {
    'crítica': '#B91C1C',
    'alta': '#EA580C',
    'média': '#D97706',
    'baixa': '#2563EB',
    'ponto forte': '#059669',
}

severity_counts = {'crítica': 0, 'alta': 0, 'média': 1, 'baixa': 0}
category_counts = {'BANCO SEM TRANCA': 1, 'PERMISSÃO NO NAVEGADOR': 0, 'IDOR': 0, 'CHAVES EXPOSTAS': 0, 'INPUTS SEM TRATAMENTO': 0}

findings = [
    {
        'severity': 'Média',
        'category': 'BANCO SEM TRANCA',
        'file': 'supabase/migrations/20261111071500_allow_authenticated_uploads.sql:1-5',
        'description': 'A policy de INSERT do bucket `MeuDriver` concede acesso a qualquer usuário autenticado, sem isolamento por `auth.uid()`. A aplicação depende de uma migração posterior para corrigir isso; sem ela, a falta de tranca de inquilino fica ativa.',
    }
]

strengths = [
    ('RLS por usuário no Supabase', 'supabase/migrations/20261111073500_user_scoped_upserts.sql:3-32', 'A política restringe inserts, selects e updates ao `bucket_id = \'MeuDriver\'` e ao primeiro segment do caminho (`auth.uid()`).'),
    ('Nenhuma secret key no código', 'src/lib/supabase.ts:3-17', 'O frontend usa `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, que são chaves públicas e não funcionam como `service_role` secret.'),
    ('Sem XSS evidente no frontend', 'src/App.tsx:4-6; src/App.tsx:1207-1215', 'Não há `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function` ou renderização de HTML/Markdown controlado por entrada do usuário.'),
]

recommendations = [
    ('P1', 'Aplicar e validar a migração de escopo por usuário no Supabase antes do primeiro upload em produção. Verificar que os policies de SELECT/UPDATE/INSERT usam `auth.uid()` e que o bucket `MeuDriver` não permanece com a policy aberta.'),
    ('P2', 'Adicionar verificação de implantação: um script de bootstrap/CI deve falhar se a policy permissiva `authenticated_upload_to_meudriver` estiver ativa em produção; documentar isso no README e em runbook de deploy.'),
    ('P3', 'Manter a política de RLS como única linha de defesa. Não confiar em filtros do frontend como controle de acesso; o browser deve apenas refletir o estado da sessão autenticada.'),
]

issue_markdown = '''--- ISSUE 1 ---
[Segurança] RLS do bucket `MeuDriver` depende de migração manual e deixa o bucket aberto sem ela

Labels sugeridas: security + media

Descrição do problema:
A migração `supabase/migrations/20261111071500_allow_authenticated_uploads.sql` cria uma policy de INSERT para `storage.objects` com `to authenticated` e `with check (bucket_id = 'MeuDriver')`. Isso permite que qualquer usuário autenticado envie objetos em qualquer caminho do bucket, sem isolar por `auth.uid()`. O projeto documenta que a regra de escopo por usuário deve ser aplicada em outra migração (`20261111073500_user_scoped_upserts.sql`), mas isso depende de execução manual e não é reforçado em deploy automático.

Por que é explorável:
Se a migração de escopo por usuário não for aplicada em produção, a proteção de tenant/usuário é inexistente no bucket e qualquer conta autenticada pode inserir/visualizar/alterar objetos no mesmo bucket em vez de somente os do seu `auth.uid()`.

Evidência:
- `supabase/migrations/20261111071500_allow_authenticated_uploads.sql:1-5`
- `supabase/migrations/20261111073500_user_scoped_upserts.sql:3-32`
- `README.md:30`

Impacto:
Exposição de arquivos entre usuários autenticados do mesmo projeto, vazamento de conteúdo e manipulação indevida de objetos do bucket.

Sugestão de correção:
- Remover a policy permissiva `authenticated_upload_to_meudriver` em produção.
- Deixar somente a policy restrita por `auth.uid()` no bucket.
- Automatizar a validação em CI/deploy para falhar caso a policy permissiva exista.
- Reexecutar testes de acesso com usuários distintos para verificar isolamento.

Critérios de aceite:
- [ ] `authenticated_upload_to_meudriver` não existe em produção.
- [ ] `SELECT`, `INSERT` e `UPDATE` no bucket exigem `bucket_id = 'MeuDriver'` e `(storage.foldername(name))[1] = (select auth.uid()::text)`.
- [ ] Um pipeline de deploy falha se a policy permissiva estiver presente.
- [ ] Testes de regressão confirmam que usuários distintos não conseguem ler ou escrever objetos de terceiros.
--- FIM ISSUE 1 ---
'''


def draw_donut(canvas, x, y, radius, colors_list, labels, values):
    total = sum(values)
    if total == 0:
        start = 0
        end = 360
        canvas.setFillColor(colors.HexColor('#E5E7EB'))
        canvas.circle(x, y, radius, stroke=1, fill=1)
        canvas.setFillColor(colors.black)
        canvas.setFont('Helvetica-Bold', 10)
        canvas.drawCentredString(x, y, '0')
        return

    start = 0
    for label, value, color in zip(labels, values, colors_list):
        if value <= 0:
            continue
        sweep = 360 * value / total
        canvas.setFillColor(colors.HexColor(color))
        canvas.circle(x, y, radius, stroke=0, fill=1)
        canvas.setFillColor(colors.HexColor('#F8FAFC'))
        canvas.circle(x, y, radius * 0.55, stroke=0, fill=1)
        # Draw wedge pie style by manual path
        from reportlab.graphics.shapes import Drawing, Wedge
        from reportlab.graphics import renderPDF
        d = Drawing(200, 200)
        d.add(Wedge(x=100, y=100, radius=100, startAngle=start, endAngle=start + sweep, fillColor=colors.HexColor(color), strokeColor=colors.HexColor(color)))
        renderPDF.draw(d, canvas, x - 100, y - 100)
        start += sweep
    canvas.setFillColor(colors.HexColor('#0F172A'))
    canvas.setFont('Helvetica-Bold', 14)
    canvas.drawCentredString(x, y, str(total))
    canvas.setFont('Helvetica', 8)
    canvas.drawCentredString(x, y - 12, 'achados')


def build_charts():
    severity_labels = ['crítica', 'alta', 'média', 'baixa']
    severity_values = [severity_counts[k] for k in severity_labels]
    severity_colors = [severity_palette[k] for k in severity_labels]

    fig, ax = plt.subplots(figsize=(5, 4), facecolor='#F8FAFC')
    wedges, texts, autotexts = ax.pie(
        severity_values,
        labels=[f'{k}\n{v}' for k, v in zip(severity_labels, severity_values)],
        colors=severity_colors,
        startangle=90,
        autopct='%1.0f',
        wedgeprops={'linewidth': 1, 'edgecolor': '#F8FAFC'},
        textprops={'color': '#0F172A', 'fontsize': 8},
    )
    ax.set(aspect='equal')
    fig.patch.set_facecolor('#F8FAFC')
    ax.set_title('Severidade', fontsize=10, color='#0F172A')
    fig.tight_layout()
    fig.savefig(SEVERITY_PNG, dpi=200)
    plt.close(fig)

    category_labels = list(category_counts.keys())
    category_values = list(category_counts.values())
    category_colors = [severity_palette['crítica'] if label == 'BANCO SEM TRANCA' else severity_palette['ponto forte'] for label in category_labels]

    fig, ax = plt.subplots(figsize=(7, 4), facecolor='#F8FAFC')
    bars = ax.bar(category_labels, category_values, color=category_colors, edgecolor='#0F172A', linewidth=0.5)
    ax.set_ylabel('Quantidade', color='#0F172A')
    ax.set_title('Categorias', fontsize=10, color='#0F172A')
    ax.set_ylim(0, max(1, max(category_values) + 1))
    ax.tick_params(axis='x', rotation=25, labelsize=8)
    for bar in bars:
        h = bar.get_height()
        ax.text(bar.get_x() + bar.get_width() / 2, h + 0.05, str(int(h)), ha='center', va='bottom', fontsize=8, color='#0F172A')
    fig.tight_layout()
    fig.savefig(CATEGORY_PNG, dpi=200)
    plt.close(fig)


class ReportTemplate:
    def __init__(self):
        self.styles = getSampleStyleSheet()
        self.normal = self.styles['BodyText']
        self.normal.fontName = 'Helvetica'
        self.normal.fontSize = 10
        self.title_style = ParagraphStyle('TitleStyle', parent=self.styles['Title'], fontName='Helvetica-Bold', fontSize=20, leading=24, textColor='#0F172A', alignment=1)
        self.section_style = ParagraphStyle('SectionStyle', parent=self.styles['Heading2'], fontName='Helvetica-Bold', fontSize=13, leading=18, textColor='#0F172A', spaceBefore=12, spaceAfter=7)
        self.subsection_style = ParagraphStyle('SubStyle', parent=self.styles['Heading3'], fontName='Helvetica-Bold', fontSize=11, leading=15, textColor='#0F172A', spaceBefore=8, spaceAfter=5)
        self.small = ParagraphStyle('Small', parent=self.styles['BodyText'], fontName='Helvetica', fontSize=8, leading=10, textColor='#475569')

    def build(self):
        doc = SimpleDocTemplate(
            str(PDF_PATH),
            pagesize=A4,
            rightMargin=18 * mm,
            leftMargin=18 * mm,
            topMargin=16 * mm,
            bottomMargin=16 * mm,
            title=f'Relatório de Auditoria de Segurança — {PROJECT_NAME}',
        )
        story = []
        story.append(Paragraph(f'Relatório de Auditoria de Segurança — {PROJECT_NAME}', self.title_style))
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph(f'Data: {datetime.now().strftime("%d/%m/%Y")}', self.normal))
        story.append(Paragraph('Escopo auditado: frontend React + Vite; autenticação e Storage por Supabase; sem backend/ORM/CI/Helm/Terraform neste repositório.', self.normal))
        story.append(Paragraph('Nota metodológica: a auditoria mapeou cada categoria à stack real: RLS em Supabase para banco/tenant, UI/cliente para permissão/inputs, e ausência de backend para IDOR; sem deploy manifests, não houve verificação de Helm/Terraform.', self.normal))
        story.append(PageBreak())

        story.append(Paragraph('Resumo executivo', self.section_style))
        summary_table = Table([
            ['Severidade', 'Quantidade'],
            ['Crítica', str(severity_counts['crítica'])],
            ['Alta', str(severity_counts['alta'])],
            ['Média', str(severity_counts['média'])],
            ['Baixa', str(severity_counts['baixa'])],
        ], colWidths=[80 * mm, 35 * mm])
        summary_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0F172A')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#CBD5E1')),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 6),
            ('TOPPADDING', (0, 0), (-1, 0), 6),
            ('ALIGN', (1, 1), (1, -1), 'CENTER'),
        ]))
        story.append(summary_table)
        story.append(Spacer(1, 6 * mm))
        story.append(Image(str(SEVERITY_PNG), width=90 * mm, height=60 * mm))
        story.append(Spacer(1, 6 * mm))
        story.append(Image(str(CATEGORY_PNG), width=120 * mm, height=60 * mm))
        story.append(PageBreak())

        story.append(Paragraph('Pontos fortes', self.section_style))
        for label, file_ref, detail in strengths:
            story.append(Paragraph(f'<b>{label}</b> — {file_ref}', self.subsection_style))
            story.append(Paragraph(detail, self.normal))
            story.append(Spacer(1, 2 * mm))

        story.append(Paragraph('Pontos fracos', self.section_style))
        story.append(Paragraph('O principal risco verificado é de configuração de isolamento de inquilino: o repositório contém uma policy permissiva de upload para qualquer usuário autenticado em `storage.objects` e a aplicação depende de uma migração adicional para restringir por `auth.uid()`. Sem essa migração, o bucket deixa de ter tranca de usuário/tenant.', self.normal))
        story.append(PageBreak())

        story.append(Paragraph('Tabela de achados detalhados', self.section_style))
        table_rows = [['Severidade', 'Arquivo:linha', 'Descrição']]
        for f in findings:
            table_rows.append([f['severity'], f['file'], f['description']])
        findings_table = Table(table_rows, colWidths=[22 * mm, 45 * mm, 90 * mm])
        findings_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E2E8F0')),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#CBD5E1')),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F8FAFC')]),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        story.append(findings_table)
        story.append(PageBreak())

        story.append(Paragraph('Recomendações priorizadas', self.section_style))
        for priority, recommendation in recommendations:
            story.append(Paragraph(f'<b>{priority}</b> — {recommendation}', self.normal))
            story.append(Spacer(1, 2 * mm))
        story.append(PageBreak())

        story.append(Paragraph('ISSUES PARA O GITHUB', self.section_style))
        for issue_block in [issue_markdown]:
            story.append(Paragraph(issue_block, self.normal))
        doc.build(story)


def main():
    build_charts()
    ReportTemplate().build()
    print(f'PDF gerado em: {PDF_PATH}')
    print(f'Charts: {SEVERITY_PNG}, {CATEGORY_PNG}')


if __name__ == '__main__':
    main()
