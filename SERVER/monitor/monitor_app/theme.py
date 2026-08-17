QSS = """
QMainWindow, QWidget {
  background: #050607;
  color: #eef3f0;
  font-family: "IBM Plex Sans", "Noto Sans", sans-serif;
  font-size: 13px;
}
QLabel#brand { color: #2ef28a; font-size: 22px; font-weight: 800; letter-spacing: 4px; }
QLabel#sub { color: #7d8882; letter-spacing: 3px; font-size: 11px; }
QLabel#live { color: #2ef28a; font-size: 16px; font-weight: 700; letter-spacing: 2px; }
QLabel#live[off="true"] { color: #ff5a5a; }
QFrame#Card {
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #141b21, stop:1 #10151a);
  border: 1px solid #1c242c;
}
QLabel#CardLabel { color: #7d8882; font-size: 11px; letter-spacing: 1px; }
QLabel#CardValue { font-size: 20px; font-weight: 700; }
QLabel#Section { color: #2ef28a; font-size: 11px; letter-spacing: 2px; font-weight: 700; }
QFrame#header {
  background: #080b0e;
  border-bottom: 1px solid #1c242c;
}
QStatusBar { background: #080b0e; color: #7d8882; }
"""
