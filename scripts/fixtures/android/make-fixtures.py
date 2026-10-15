# Three different documents for the Android tests (scripts/fixtures/android):
# different titles, page counts, page shapes and fonts, so a tile or column
# showing the WRONG document cannot pass for the right one.
from reportlab.lib.pagesizes import A4, landscape, letter
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.pdfbase.pdfmetrics import stringWidth

def doc(name, title, subtitle, pages, size, color, font='Helvetica'):
    c = canvas.Canvas(name, pagesize=size)
    c.setTitle(title)
    w, h = size
    for i in range(1, pages + 1):
        c.setFillColor(HexColor(color)); c.rect(0, h - 70, w, 70, stroke=0, fill=1)
        c.setFillColor(HexColor('#ffffff')); c.setFont(font + '-Bold' if font != 'Times' else 'Times-Bold', 26)
        c.drawString(40, h - 48, title)
        body = font if font != 'Times' else 'Times-Roman'
        lines = [f'{title}: línea {k + 1} de la página {i}. Texto de prueba con acentos: áéíóú ñ ¿? ¡!' for k in range(12)]
        # Every line inside the page's margins, whatever the font's width
        pt = min(14, (w - 80) / max(stringWidth(l, body, 1) for l in lines))
        c.setFillColor(HexColor('#222222')); c.setFont(body, 14)
        c.drawString(40, h - 110, f'{subtitle} — página {i} de {pages}')
        c.setFont(body, pt)
        y = h - 150
        for line in lines:
            c.drawString(40, y, line)
            y -= 22
        c.showPage()
    c.save()

doc('economia.pdf', 'Economía General II', 'Práctica calificada', 3, A4, '#1b5e20', 'Times')
doc('calculo.pdf', 'Matemáticas II', 'Cálculo integral (apaisado)', 8, landscape(A4), '#0d47a1')
doc('historia.pdf', 'Historia del Perú', 'Lectura obligatoria', 2, letter, '#b71c1c', 'Courier')
