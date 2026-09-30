"""Public UI acceptance via codex-firefox. No chat sent or paid job started."""
import os,time,json
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.support.ui import Select
out=Path(os.environ.get('OMG_UI_EVIDENCE',str(Path.home()/'.cache/omg-06150-fix/ui')));out.mkdir(parents=True,exist_ok=True)
url='https://agentbox2.tailda028c.ts.net/'
o=Options();o.add_argument('-profile');o.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);d=webdriver.Firefox(options=o);w=WebDriverWait(d,35);saved=None
prefixes=['lfg_v2','lfg_prompt_stash','omg_model','omg:overview','lfg_stage','lfg_rail','omg_fast','omg_tibo','theme','lfg_theme','lfg_model_']
def vis(css):
 try:return [e for e in d.find_elements(By.CSS_SELECTOR,css) if e.is_displayed()]
 except StaleElementReferenceException:return []
def button(label):return w.until(lambda _:next(iter(vis('button[aria-label='+json.dumps(label)+']')),False))
def ready():w.until(lambda _:vis('textarea'))
def bounds(css):
 return d.execute_script('const e=[...document.querySelectorAll(arguments[0])].find(x=>x.getBoundingClientRect().height>0),r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,outside:r.left<-1||r.top<-1||r.right>innerWidth+1||r.bottom>innerHeight+1,documentOverflow:document.documentElement.scrollWidth>innerWidth}',css)
try:
 d.set_window_size(1500,900);d.get(url);ready()
 saved=d.execute_script('return Object.fromEntries(Object.entries(localStorage).filter(([k])=>arguments[0].some(p=>k.startsWith(p))))',prefixes)
 assert d.execute_async_script('const done=arguments[0];fetch("/api/install?ready=1").then(r=>r.json()).then(x=>done(x.version))')=='0.6.150'
 if vis('button[aria-label="Alle projecten tonen"]'):button('Alle projecten tonen').click()
 for width,height in [(1500,900),(1200,750),(1024,700)]:
  d.set_window_size(width,height);time.sleep(.3)
  trigger=w.until(lambda _:vis('[data-testid="workspace-findings-trigger"]'))[0];trigger.click()
  w.until(lambda _:vis('[data-testid="workspace-findings-popover"]'));time.sleep(.3)
  b=bounds('[data-testid="workspace-findings-popover"]');assert not b['outside'] and not b['documentOverflow'],b
  assert d.execute_script('const e=document.querySelector("[data-testid=workspace-findings-list]");e.scrollTop=e.scrollHeight;return getComputedStyle(e).overflowY')=='auto'
  d.save_screenshot(str(out/f'updates-{width}.png'));print('UPDATES_BOUNDS_OK',json.dumps(b),flush=True)
  d.switch_to.active_element.send_keys(Keys.ESCAPE);w.until(lambda _:not vis('[data-testid="workspace-findings-popover"]'))
  assert d.execute_script('return document.activeElement?.getAttribute("data-testid")')=='workspace-findings-trigger'
 # Outside click closes without requiring another menu or changing an item.
 d.set_window_size(1500,900);time.sleep(.3)
 vis('[data-testid="workspace-findings-trigger"]')[0].click();w.until(lambda _:vis('[data-testid="workspace-findings-popover"]'))
 d.find_element(By.TAG_NAME,'textarea').click();w.until(lambda _:not vis('[data-testid="workspace-findings-popover"]'))
 print('UPDATES_ESCAPE_FOCUS_OUTSIDE_OK',flush=True)
 vis('[data-testid="workspace-findings-trigger"]')[0].click();w.until(lambda _:vis('[data-testid="workspace-findings-popover"]'))
 row=vis('[data-testid="workspace-findings-list"] button')[0];row.click()
 w.until(lambda _:vis('[data-auto-agent-page]'));assert not vis('[data-testid="workspace-findings-popover"]')
 assert not bounds('[data-auto-agent-page]')['outside'];button('Back').click();ready();print('REPORT_OPEN_BACK_OK_NO_TRIAGE',flush=True)
 d.set_window_size(1500,900)
 button('Pages').click();theme=w.until(lambda _:vis('[aria-label="Toggle dark mode"]'))[0];old=d.execute_script('return document.documentElement.classList.contains("dark")');theme.click();time.sleep(.2)
 assert d.execute_script('return document.documentElement.classList.contains("dark")')!=old
 theme.click();d.switch_to.active_element.send_keys(Keys.ESCAPE);print('QUICK_DARK_MODE_OK',flush=True)
 button('Eigen media maken').click();w.until(lambda _:vis('select[name="provider"]'))
 provider=Select(vis('select[name="provider"]')[0]);ids={e.get_attribute('value') for e in provider.options}
 assert {'chatgpt','openai','google-flow','kie'}<=ids,ids
 for source in ['chatgpt','openai','google-flow','kie']:
  Select(vis('select[name="provider"]')[0]).select_by_value(source);time.sleep(.2)
  assert vis('section[aria-label="Eigen media"]')
 vis('[role="dialog"]')[0].send_keys(Keys.ESCAPE);w.until(lambda _:not vis('select[name="provider"]'))
 print('OWN_MEDIA_FOUR_PROVIDERS_OK_NO_GENERATION',flush=True)
 button('New thread').click();w.until(lambda _:d.current_url.endswith('/threads/new'));assert vis('textarea');assert not vis('[data-desktop-workspace]');button('Back').click();ready();print('THREAD_OPEN_BACK_OK_NO_SEND',flush=True)
 # The provider picker is checked in its actual mobile layout. Preferences
 # are restored at the end; select no chat or paid generation.
 d.get(url);ready();d.execute_script('document.body.replaceChildren();const f=document.createElement("iframe");f.src=arguments[0];f.style.cssText="width:390px;height:844px;border:0";document.body.append(f)',url)
 w.until(lambda _:d.find_elements(By.TAG_NAME,'iframe'));d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'));ready();time.sleep(.8)
 assert not d.execute_script('return document.documentElement.scrollWidth>innerWidth')
 pill=next((e for e in vis('button') if 'from auto agents. Open' in (e.get_attribute('aria-label') or '')),None)
 if pill:
  pill.click();w.until(lambda _:vis('[role="dialog"]'));time.sleep(.5);b=bounds('[role="dialog"]');assert not b['outside'],b
  d.find_element(By.TAG_NAME,'html').screenshot(str(out/'mobile-updates.png'))
  vis('[role="dialog"]')[0].send_keys(Keys.ESCAPE);w.until(lambda _:not vis('[data-slot="findings-sheet"]'))
  print('MOBILE_UPDATES_NO_OVERFLOW_OK',flush=True)
 picker=w.until(lambda _:vis('button[aria-label^="Selection:"]'))[0];picker.click();w.until(lambda _:vis('[data-testid="compact-model-picker"]'))
 vis('button[aria-label^="Agent:"][aria-controls]')[0].click();button('OpenCode agent').click();button('All models').click()
 search=w.until(lambda _:vis('input[placeholder="Filter models"]'))[0];search.send_keys('glm-5.3-flash')
 w.until(lambda _:next((e for e in vis('button') if e.text.strip()=='GLM 5.3 Flash'),False)).click()
 button('Usage and next resets').click();assert 'Gebruik van alle agents' in d.find_element(By.TAG_NAME,'body').text
 assert not d.execute_script('return document.documentElement.scrollWidth>innerWidth')
 d.switch_to.default_content();d.find_element(By.TAG_NAME,'iframe').screenshot(str(out/'mobile-flash-usage.png'));print('FLASH_FAVORITES_PICKER_USAGE_OK',flush=True)
 d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'));button('Back to picker').click()
 vis('button[aria-label^="Agent:"][aria-controls]')[0].click();button('Codex agent').click();button('All models').click()
 w.until(lambda _:vis('input[placeholder="Filter models"]'))[0].send_keys('gpt-6.1-sol')
 w.until(lambda _:next((e for e in vis('button') if e.text.strip()=='GPT-6.1 Sol'),False)).click()
 d.switch_to.default_content();d.find_element(By.TAG_NAME,'iframe').screenshot(str(out/'mobile-sol61.png'));d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'))
 print('SOL61_PICKER_OK_NO_CHAT_SENT',flush=True)
 # Respect the signed-in catalog: Sol 6.1 is standard-only today. Verify
 # the existing per-chat Daybreak toggle on an actually entitled model.
 button('All models').click();w.until(lambda _:vis('input[placeholder="Filter models"]'))[0].send_keys('gpt-5.6-sol')
 w.until(lambda _:next((e for e in vis('button') if e.text.strip()=='GPT-5.6 Sol'),False)).click()
 select=w.until(lambda _:vis('[data-testid="compact-model-picker"] select'))[0]
 opts=Select(select);assert any('Blue' in o.text for o in opts.options)
 old=select.get_attribute('value');blue=next(o.get_attribute('value') for o in opts.options if 'Blue' in o.text)
 opts.select_by_value(blue);assert vis('[data-testid="compact-model-picker"] select')[0].get_attribute('value')==blue
 Select(vis('[data-testid="compact-model-picker"] select')[0]).select_by_value(old)
 d.switch_to.default_content();d.find_element(By.TAG_NAME,'iframe').screenshot(str(out/'mobile-daybreak.png'))
 print('DAYBREAK_PICKER_OK_NO_CHAT_SENT',flush=True)
 print('PUBLIC_UI_06150_OK',flush=True)
except:
 try:d.save_screenshot(str(out/'failure.png'))
 except:pass
 raise
finally:
 if saved is not None:
  try:
   d.switch_to.default_content();d.get(url);ready();d.execute_script('for(const k of Object.keys(localStorage))if(arguments[1].some(p=>k.startsWith(p)))localStorage.removeItem(k);for(const[k,v]of Object.entries(arguments[0]))localStorage.setItem(k,v)',saved,prefixes)
  except Exception:pass
 d.quit()
