import os,time,json
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
out=Path(os.environ.get('OMG_UI_EVIDENCE',str(Path.home()/'.cache/omg-update-06143')));out.mkdir(parents=True,exist_ok=True);url='https://agentbox2.tailda028c.ts.net/'
o=Options();o.add_argument('-profile');o.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);d=webdriver.Firefox(options=o);w=WebDriverWait(d,35);saved=None
prefixes=['lfg_v2','lfg_prompt_stash','omg_model','omg:overview','lfg_stage','lfg_rail','omg_fast','omg_tibo','theme','lfg_theme']
def vis(css):return [e for e in d.find_elements(By.CSS_SELECTOR,css) if e.is_displayed()]
def btn(label):return w.until(lambda _:next((e for e in vis('button') if e.get_attribute('aria-label')==label),False))
def ready():w.until(lambda _:vis('input[aria-label="Zoek een gesprek"]'))
def shot(name):d.save_screenshot(str(out/(name+'.png')))
try:
 d.set_window_size(1600,1000);d.get(url);ready();time.sleep(2)
 saved=d.execute_script('return Object.fromEntries(Object.entries(localStorage).filter(([k])=>arguments[0].some(p=>k.startsWith(p))))',prefixes)
 assert d.execute_async_script('const done=arguments[0];fetch("/api/install?ready=1").then(r=>r.json()).then(x=>done(x.version))')=='0.6.143'
 btn('Pages').click();theme=w.until(lambda _:next(iter(vis('[aria-label="Toggle dark mode"]')),False));old=d.execute_script('return document.documentElement.classList.contains("dark")');theme.click();time.sleep(.3)
 assert d.execute_script('return document.documentElement.classList.contains("dark")')!=old;theme.click();btn('Pages').click()
 print('QUICK_DARK_MODE_PRESERVED',flush=True)
 btn('New thread').click();w.until(lambda _:d.current_url.endswith('/threads/new'));assert not vis('[data-desktop-workspace]');assert vis('textarea')
 shot('new-thread');btn('Back').click();ready();print('NEW_THREAD_OPEN_BACK_OK_WITHOUT_SEND',flush=True)
 d.execute_script('document.activeElement.blur()');ActionChains(d).send_keys(Keys.SHIFT).perform();w.until(lambda _:vis('[role="dialog"][aria-label="Agent usage"]'));shot('usage-campfire')
 choices=[e for e in vis('button') if 'Codex' in (e.get_attribute('aria-label') or e.text)]
 print('CAMPFIRE_CODEX_BUTTONS',[(e.get_attribute('aria-label'),e.text[:40]) for e in choices],flush=True)
 if choices:choices[0].click();time.sleep(.4)
 # Close usage safely, then check the composer is still mounted after selecting an agent.
 if vis('[role="dialog"][aria-label="Agent usage"]'):d.switch_to.active_element.send_keys(Keys.ESCAPE)
 assert 'Minified React error' not in d.find_element(By.TAG_NAME,'body').text
 assert vis('textarea');print('CAMPFIRE_NO_REACT_CRASH',flush=True)
 d.get(url);ready()
 d.execute_script('document.body.replaceChildren();const f=document.createElement("iframe");f.src=arguments[0];f.style.cssText="width:390px;height:844px;border:0";document.body.append(f)',url)
 w.until(lambda _:d.find_elements(By.TAG_NAME,'iframe'));d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'));ready();time.sleep(2)
 assert not d.execute_script('return document.documentElement.scrollWidth>innerWidth')
 assert vis('button[aria-label^="Selection:"]')
 vis('button[aria-label^="Selection:"]')[0].click();w.until(lambda _:vis('[data-testid="compact-model-picker"]'))
 vis('button[aria-label^="Agent:"][aria-controls]')[0].click();btn('OpenCode agent').click();btn('All models').click()
 search=w.until(lambda _:next(iter(vis('input[placeholder="Filter models"]')),False));search.send_keys('glm-5.3-flash')
 w.until(lambda _:next((e for e in vis('button') if e.text.strip()=='GLM 5.3 Flash'),False)).click()
 w.until(lambda _:vis('[data-testid="compact-model-picker"]'));btn('Usage and next resets').click()
 assert 'Gebruik van alle agents' in d.find_element(By.TAG_NAME,'body').text
 d.switch_to.default_content();d.find_element(By.TAG_NAME,'iframe').screenshot(str(out/'mobile-picker-usage.png'));d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'))
 print('MOBILE_390_FLASH_PICKER_USAGE_OK',flush=True)
 print('EXTRA_UI_PASS',flush=True)
except:
 shot('extra-ui-failure');print('BUTTONS',[(e.get_attribute('aria-label'),e.text[:50]) for e in vis('button')][-30:],flush=True);raise
finally:
 if saved is not None:
  try:d.execute_script('for(const k of Object.keys(localStorage))if(arguments[1].some(p=>k.startsWith(p)))localStorage.removeItem(k);for(const[k,v]of Object.entries(arguments[0]))localStorage.setItem(k,v)',saved,prefixes)
  except Exception:pass
 d.quit()
