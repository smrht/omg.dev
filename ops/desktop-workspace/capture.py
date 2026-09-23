import os,time,argparse,json
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
p=argparse.ArgumentParser();p.add_argument('--url',default='http://127.0.0.1:5176/');p.add_argument('--name',default='baseline');p.add_argument('--width',type=int,default=1619);p.add_argument('--height',type=int,default=971);a=p.parse_args()
o=Options();o.add_argument('-profile');o.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);d=webdriver.Firefox(options=o)
out=Path(__file__).parent/'evidence';out.mkdir(exist_ok=True)
try:
 d.set_window_size(a.width,a.height+90);delta=d.execute_script("return outerHeight-innerHeight");d.set_window_size(a.width,a.height+delta);d.get(a.url);w=WebDriverWait(d,40)
 w.until(lambda d:d.find_elements(By.CSS_SELECTOR,'input[aria-label="Zoek een gesprek"]') or 'Who are you?' in d.find_element(By.TAG_NAME,'body').text)
 if 'Who are you?' in d.find_element(By.TAG_NAME,'body').text:
  b=[e for e in d.find_elements(By.TAG_NAME,'button') if e.is_displayed() and e.text.strip().lower().startswith(('sam','rocketmansh'))];assert len(b)==1;b[0].click()
 time.sleep(4)
 d.save_screenshot(str(out/(a.name+'.png')))
 print(json.dumps(d.execute_script('return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll("button")].filter(e=>e.getBoundingClientRect().width).map(e=>({a:e.getAttribute("aria-label"),t:e.textContent.slice(0,60)}))}')),flush=True)
finally:d.quit()
