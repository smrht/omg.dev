import os,json,time,argparse
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
p=argparse.ArgumentParser();p.add_argument('--url',default='http://127.0.0.1:5176/model-picker-qa.html');p.add_argument('--frame',action='store_true');p.add_argument('--width',type=int,default=390);p.add_argument('--height',type=int,default=844);p.add_argument('--prefix',default='local');a=p.parse_args()
out=Path(__file__).parent/'evidence';out.mkdir(exist_ok=True)
o=Options();o.add_argument('-profile');o.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);d=webdriver.Firefox(options=o);w=WebDriverWait(d,35);saved=None
prefixes=['lfg_v2','lfg_prompt_stash_v1','omg_fast_mode_','omg_tibo_mode','omg_model_favorites_','omg:overview:']
def vis(css):return [e for e in d.find_elements(By.CSS_SELECTOR,css) if e.is_displayed()]
def btn(label):return w.until(lambda _:next((e for e in vis('button') if e.get_attribute('aria-label')==label),False))
def txt(label):return w.until(lambda _:next((e for e in vis('button') if e.text.strip()==label),False))
def root():return w.until(lambda _:next(iter(vis('[data-testid="compact-model-picker"]')),False))
def summary():return w.until(lambda _:next(iter(vis('button[aria-label^="Selection:"]')),False))
def open_picker():summary().click();root()
def close_picker():btn('Close model picker').click();w.until(lambda _:not vis('[data-testid="compact-model-picker"]'))
def all_models(query):
 btn('All models').click();search=w.until(lambda _:next(iter(vis('input[placeholder="Filter models"]')),False));search.clear();search.send_keys(query);return search

def shot(name):
 if a.frame:
  d.switch_to.default_content();d.find_element(By.TAG_NAME,'iframe').screenshot(str(out/f'{a.prefix}-{name}.png'));d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'))
 else:d.save_screenshot(str(out/f'{a.prefix}-{name}.png'))
def reload():
 d.switch_to.default_content();d.refresh()
 if a.frame:d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'))
 w.until(lambda _:vis('input[aria-label="Zoek een gesprek"]'));time.sleep(.5)
try:
 d.set_window_size(1440,1050);d.get(a.url)
 if a.frame:
  frame=d.find_element(By.TAG_NAME,'iframe');d.execute_script('arguments[0].style.width=arguments[1]+"px";arguments[0].style.height=arguments[2]+"px"',frame,a.width,a.height);d.switch_to.frame(frame)
 w.until(lambda _:'Who are you?' in d.find_element(By.TAG_NAME,'body').text or vis('input[aria-label="Zoek een gesprek"]'))
 if 'Who are you?' in d.find_element(By.TAG_NAME,'body').text:
  candidates=[b for b in vis('button') if b.text.strip().lower().startswith(('sam','rocketmansh'))];assert len(candidates)==1;candidates[0].click()
 w.until(lambda _:vis('input[aria-label="Zoek een gesprek"]'));time.sleep(1)
 saved=d.execute_script('return Object.fromEntries(Object.entries(localStorage).filter(([k])=>arguments[0].some(p=>k.startsWith(p))))',prefixes)
 open_picker()
 header=w.until(lambda _:next(iter(vis('button[aria-label^="Agent:"][aria-controls]')),False));header.click()
 choices=w.until(lambda _:vis('button[aria-label="OpenCode agent"]'))
 choices[0].click();w.until(lambda _:root().get_attribute('aria-label').startswith('OpenCode'))
 for name,query in [('GPT-5.5','openai/gpt-5.5'),('GLM 5.3','zai-coding-plan/glm-5.3'),('GLM 5.3 Flash','glm-5.3-flash')]:
  all_models(query)
  remove=vis(f'button[aria-label="Remove {name} from favorites"]')
  if remove:remove[0].click()
  btn(f'Favorite {name}').click()
  if name=='GLM 5.3 Flash':txt(name).click()
  else:btn('Back to picker').click()
 txt('Max').click();w.until(lambda _:'GLM 5.3 Flash · Max' in summary().text)
 assert len(root().find_elements(By.CSS_SELECTOR,'button[aria-label^="Remove "]'))==3
 assert [e.text for e in root().find_elements(By.CSS_SELECTOR,'[role="radio"]')]==['Laag','Hoog','Max']
 geometry=d.execute_script('const e=document.querySelector("[data-testid=compact-model-picker]"),r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,targets:[...e.querySelectorAll("button")].map(b=>({a:b.getAttribute("aria-label"),h:b.getBoundingClientRect().height}))}')
 assert geometry['top']>=0 and geometry['left']>=12 and geometry['width']<=414 and not geometry['overflow'],geometry
 assert all(b['h']>=44 for b in geometry['targets']),geometry
 for dark in [False,True]:
  d.execute_script('document.documentElement.classList.toggle("dark",arguments[0])',dark);time.sleep(.2);shot('picker-dark' if dark else 'picker-light')
 btn('Remove GLM 5.3 Flash from favorites').click();assert 'GLM 5.3 Flash · Max' in summary().text
 all_models('glm-5.3-flash');btn('Favorite GLM 5.3 Flash').click();btn('Back to picker').click()
 btn('Usage and next resets').click();assert 'local stats' in root().text or 'No limit data' in root().text or 'Signed in' in root().text;assert '%' not in root().text
 shot('usage');txt('Gebruik van alle agents').click();w.until(lambda _:vis('[role="dialog"][aria-label="Agent usage"]'));d.switch_to.active_element.send_keys(Keys.ESCAPE);w.until(lambda _:not vis('[role="dialog"][aria-label="Agent usage"]'));open_picker()
 # Agent switch must not leak OpenCode favorites; profiles remain explicit.
 vis('button[aria-label^="Agent:"][aria-controls]')[0].click();btn('Claude agent').click()
 assert 'GLM 5.3 Flash' not in root().text
 print('Agent separation verified',flush=True)
 vis('button[aria-label^="Agent:"][aria-controls]')[0].click()
 profiles=vis('button[aria-label="Claude profiles"]')
 if profiles:
  profiles[0].click();assert 'Claude-profielen' in root().text;btn('Back to picker').click()
 else:vis('button[aria-label^="Agent:"][aria-controls]')[0].click()
 assert vis('[role="switch"]'),'Claude extra modes missing'
 vis('button[aria-label^="Agent:"][aria-controls]')[0].click();btn('OpenCode agent').click()
 assert 'GLM 5.3 Flash' in root().text
 close_picker();reload();open_picker()
 # Existing composer persists the last launched agent, not an unsubmitted choice.
 if not root().get_attribute('aria-label').startswith('OpenCode'):
  vis('button[aria-label^="Agent:"][aria-controls]')[0].click();btn('OpenCode agent').click()
 assert 'GLM 5.3 Flash' in root().text
 w.until(lambda _:next((b for b in root().find_elements(By.TAG_NAME,'button') if (b.get_attribute('aria-label') or '').startswith('Model GLM 5.3 Flash ')),False)).click()
 # Keyboard arrows change both checked value and focus.
 radios=root().find_elements(By.CSS_SELECTOR,'[role="radio"]');checked=next(e for e in radios if e.get_attribute('aria-checked')=='true');checked.send_keys(Keys.HOME)
 assert d.switch_to.active_element.text=='Laag';assert d.switch_to.active_element.get_attribute('aria-checked')=='true'
 d.switch_to.active_element.send_keys(Keys.END);assert d.switch_to.active_element.text=='Max'
 d.switch_to.active_element.send_keys(Keys.ESCAPE);w.until(lambda _:not vis('[data-testid="compact-model-picker"]'))
 assert vis('button[aria-label="Attach files"]') and vis('button[aria-label="Dictate"]')
 assert d.switch_to.active_element.get_attribute('aria-label').startswith('Selection:'),'focus did not return'
 # Primary input expands without remounting/lost text; never submit.
 textarea=vis('textarea')[0];textarea.send_keys(Keys.COMMAND,'a');textarea.send_keys('Model picker QA — niet verzenden')
 w.until(lambda _:vis('button[aria-label="Start session"]'));assert textarea.get_attribute('value')=='Model picker QA — niet verzenden'
 textarea.send_keys(Keys.COMMAND,'a');textarea.send_keys(Keys.BACKSPACE)
 print(json.dumps({'live_profiles_available':bool(profiles),'result':'MODEL_PICKER_BROWSER_OK','geometry':geometry,'favorites_reload_agent_isolation':True,'profiles_usage_thinking_keyboard':True,'composer_draft_retained':True,'submitted':False}),flush=True)
except:
 try:shot('failure');print(root().text[:1200],flush=True)
 except:pass
 raise
finally:
 if saved is not None:
  d.execute_script('for(const k of Object.keys(localStorage))if(arguments[1].some(p=>k.startsWith(p)))localStorage.removeItem(k);for(const[k,v]of Object.entries(arguments[0]))localStorage.setItem(k,v)',saved,prefixes)
 d.quit()
