import os,sys,json,time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
p=Options();p.add_argument('-profile');p.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);p.add_argument('-headless')
d=webdriver.Firefox(options=p)
try:
 d.set_window_size(390,844);d.get(sys.argv[1]);w=WebDriverWait(d,30);w.until(lambda d:d.find_elements(By.CSS_SELECTOR,'[data-overview-row]'))
 dimensions=d.execute_script('return {width:innerWidth,scroll:document.documentElement.scrollWidth,height:innerHeight}')
 assert dimensions['scroll']<=dimensions['width'],dimensions
 for e in d.find_elements(By.CSS_SELECTOR,'.overview-toolbar button,.overview-toolbar input'):
  r=e.rect;assert r['x']>=0 and r['x']+r['width']<=dimensions['width']+1,r
 d.save_screenshot(str(Path(__file__).parent/'evidence/narrow.png'))
 print(json.dumps(dimensions))
finally:d.quit()
