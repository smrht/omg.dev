import os,json,time,sys
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.keys import Keys
out=Path(__file__).parent/'evidence';out.mkdir(exist_ok=True)
o=Options();o.add_argument('-profile');o.add_argument(os.environ['CODEX_FIREFOX_PROFILE'])
d=webdriver.Firefox(options=o);w=WebDriverWait(d,35);saved=None
try:
 d.set_window_size(1440,1000);d.get(sys.argv[1]);w.until(lambda d:d.find_elements(By.CSS_SELECTOR,'input[aria-label="Zoek een gesprek"]') or 'Who are you?' in d.find_element(By.TAG_NAME,'body').text)
 if 'Who are you?' in d.find_element(By.TAG_NAME,'body').text:
  choices=[b for b in d.find_elements(By.TAG_NAME,'button') if b.text.strip().lower().startswith(('sam', 'rocketmansh'))];assert len(choices)==1;choices[0].click()
 w.until(lambda d:d.find_elements(By.CSS_SELECTOR,'input[aria-label="Zoek een gesprek"]'))
 saved=d.execute_script('return Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith("lfg_v2")||k.startsWith("omg:overview:")))')
 clear=d.find_elements(By.CSS_SELECTOR,'button[aria-label="Alle projecten tonen"]')
 if clear:clear[0].click()
 w.until(lambda d:d.find_elements(By.CSS_SELECTOR,'[data-overview-row]'))
 baseline=d.execute_script('return {dark:document.documentElement.classList.contains("dark"),view:localStorage.getItem("omg:overview:view"),density:localStorage.getItem("omg:overview:density")}')
 for label,width,height in [('desktop',1440,1000),('mobile',500,932)]:
  d.set_window_size(width,height);time.sleep(1)
  search=w.until(lambda d:next((e for e in d.find_elements(By.CSS_SELECTOR,'input[aria-label="Zoek een gesprek"]') if e.is_displayed()),False))
  rows=d.find_elements(By.CSS_SELECTOR,'[data-overview-row]');assert rows
  sizes=d.execute_script('return [...document.querySelectorAll("[data-overview-row]")].map(e=>e.getBoundingClientRect().height)');assert all(v==60 for v in sizes),sizes
  search.click();search.send_keys(Keys.TAB)
  assert d.execute_script("return document.activeElement.closest('section')?.getAttribute('aria-label') === 'Gesprekkenoverzicht'"), 'Tab escaped toolbar'
  search.send_keys('zz-no-such-session-739');w.until(lambda d:'Geen gesprekken gevonden' in d.find_element(By.TAG_NAME,'body').text);assert not d.find_elements(By.CSS_SELECTOR,'[data-overview-row]')
  d.find_element(By.CSS_SELECTOR,'button[aria-label="Zoekopdracht wissen"]').click();w.until(lambda d:len(d.find_elements(By.CSS_SELECTOR,'[data-overview-row]'))>0)
  for name in ['Projecten','Alle chats','Aandacht']:
   button=d.find_element(By.XPATH,f'//button[@aria-pressed and normalize-space()="{name}"]');button.click();assert button.get_attribute('aria-pressed')=='true'
  density=d.find_element(By.CSS_SELECTOR,'button[aria-label="Ruime weergave"]');density.click();w.until(lambda d:d.find_element(By.CSS_SELECTOR,'[data-overview-row]').size['height']==76)
  d.refresh();w.until(lambda d:d.find_elements(By.CSS_SELECTOR,'button[aria-label="Compacte weergave"]'));d.find_element(By.CSS_SELECTOR,'button[aria-label="Compacte weergave"]').click();w.until(lambda d:d.find_element(By.CSS_SELECTOR,'[data-overview-row]').size['height']==60)
  for dark in [False,True]:
   d.execute_script('document.documentElement.classList.toggle("dark",arguments[0]);',dark)
   time.sleep(.2);d.save_screenshot(str(out/f'{label}-{"dark" if dark else "light"}.png'))
  print(json.dumps({'viewport':label,'width':d.execute_script('return innerWidth'),'rows':len(d.find_elements(By.CSS_SELECTOR,'[data-overview-row]')),'density':sizes[0],'search_filters_density_reload':True}),flush=True)
 d.execute_script('document.documentElement.classList.toggle("dark",arguments[0]);',baseline['dark'])
 for key in ['view','density']:
  d.execute_script('if(arguments[1]===null)localStorage.removeItem(arguments[0]);else localStorage.setItem(arguments[0],arguments[1]);','omg:overview:'+key,baseline[key])
except Exception:
 d.save_screenshot(str(out/'failure.png'))
 print(d.find_element(By.TAG_NAME,'body').text[:1800],flush=True)
 raise
finally:
 if saved is not None:
  d.execute_script('for(const k of Object.keys(localStorage))if(k.startsWith("lfg_v2")||k.startsWith("omg:overview:"))localStorage.removeItem(k);for(const [k,v] of Object.entries(arguments[0]))localStorage.setItem(k,v)',saved)
 d.quit()
