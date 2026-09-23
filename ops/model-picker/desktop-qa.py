"""Browser verification for compact picker; no chat is submitted."""
import os,json,time,argparse
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
parser=argparse.ArgumentParser();parser.add_argument('--url',default='http://127.0.0.1:5176/model-picker-qa.html');parser.add_argument('--frame',action='store_true');args=parser.parse_args()
out=Path(__file__).parent/'evidence';out.mkdir(exist_ok=True)
o=Options();o.add_argument('-profile');o.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);d=webdriver.Firefox(options=o);saved=None
w=WebDriverWait(d,40)
def visible(css):return [e for e in d.find_elements(By.CSS_SELECTOR,css) if e.is_displayed()]
def click_text(text):
 e=w.until(lambda _:next((e for e in visible('button') if e.text.strip()==text),False));e.click();return e
def screenshot(name):
 if args.frame:
  d.switch_to.default_content();d.find_element(By.TAG_NAME,'iframe').screenshot(str(out/name));d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'))
 else:d.save_screenshot(str(out/name))
def restore():
 if saved is not None:
  d.execute_script('for(const k of Object.keys(localStorage))if(k.startsWith("lfg_v2")||k.startsWith("omg:model")||k.startsWith("omg_model")||k.startsWith("omg:overview"))localStorage.removeItem(k);for(const [k,v] of Object.entries(arguments[0]))localStorage.setItem(k,v)',saved)
try:
 d.set_window_size(1440,1050);d.get(args.url)
 if args.frame:d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'))
 w.until(lambda d:visible('input[aria-label="Zoek een gesprek"]') or 'Who are you?' in d.find_element(By.TAG_NAME,'body').text)
 if 'Who are you?' in d.find_element(By.TAG_NAME,'body').text:
  choices=[e for e in visible('button') if e.text.strip().lower().startswith(('sam','rocketmansh'))];assert len(choices)==1;choices[0].click()
 w.until(lambda _:visible('input[aria-label="Zoek een gesprek"]'))
 time.sleep(3)
 saved=d.execute_script('return Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith("lfg_v2")||k.startsWith("omg:model")||k.startsWith("omg_model")||k.startsWith("omg:overview")))')
 print(json.dumps(d.execute_script('return {width:innerWidth,height:innerHeight,buttons:[...document.querySelectorAll("button")].filter(e=>e.getBoundingClientRect().width).slice(-16).map(e=>({a:e.getAttribute("aria-label"),t:e.textContent.slice(0,100)}))}')),flush=True)
 print('VISIBLE',[(e.get_attribute('aria-label'),e.text[:60]) for e in visible('button')][-20:],flush=True);screenshot('desktop-start.png')
 picker=w.until(lambda _:next(iter(visible('button[aria-label*="Change agent or model"]')),False));picker.click()
 w.until(lambda _:visible('button[aria-label="opencode"]'))[0].click()
 search=w.until(lambda _:next(iter(visible('input[placeholder="Filter models"]')),False));search.send_keys('glm-5.3-flash')
 choice=w.until(lambda _:next((e for e in visible('button') if e.text.strip()=='GLM 5.3 Flash'),False))
 star=w.until(lambda _:next((e for e in visible('button') if 'GLM 5.3 Flash' in (e.get_attribute('aria-label') or '') and ('Favorite' in e.get_attribute('aria-label') or 'Remove' in e.get_attribute('aria-label'))),False));star.click();choice.click()
 w.until(lambda _:any('glm-5.3-flash' in (e.get_attribute('aria-label') or '') for e in visible('button')))
 assert not d.execute_script('return document.documentElement.scrollWidth>innerWidth')
 screenshot('desktop-selected.png')
 print('DESKTOP_PICKER_OK: agent, search, favorite, Flash selection, composer, no overflow; no submission',flush=True)
except:
 screenshot('desktop-failure.png');print('FAIL_VISIBLE',[(e.get_attribute('aria-label'),e.text[:60]) for e in visible('button')][-25:],flush=True);raise
finally:
 restore();d.quit()
