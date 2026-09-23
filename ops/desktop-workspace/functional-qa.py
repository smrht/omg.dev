"""Real browser desktop verification. Never sends a chat or starts/stops a job."""
import os,time,json,argparse
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import StaleElementReferenceException
p=argparse.ArgumentParser();p.add_argument('--url',default='http://127.0.0.1:5176/');p.add_argument('--prefix',default='local');a=p.parse_args()
out=Path(__file__).parent/'evidence';out.mkdir(exist_ok=True)
o=Options();o.add_argument('-profile');o.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);d=webdriver.Firefox(options=o);w=WebDriverWait(d,40,ignored_exceptions=(StaleElementReferenceException,));saved=None
keys=['lfg_v2','lfg_prompt_stash','omg_model','omg:overview:','lfg_stage_pinned','lfg_rail_collapsed','omg_fast_mode','omg_tibo_mode']
def vis(css):return [e for e in d.find_elements(By.CSS_SELECTOR,css) if e.is_displayed()]
def button(text):return w.until(lambda _:next((e for e in vis('button') if e.text.strip()==text),False))
def shot(name):d.save_screenshot(str(out/(a.prefix+'-'+name+'.png')))
def setsize(width,height):
 d.set_window_size(width,height+90);delta=d.execute_script('return outerHeight-innerHeight');d.set_window_size(width,height+delta);time.sleep(.4)
def search():return w.until(lambda _:next(iter(vis('input[aria-label="Zoek een gesprek"]')),False))
try:
 setsize(1619,971);d.get(a.url)
 w.until(lambda _:vis('input[aria-label="Zoek een gesprek"]') or 'Who are you?' in d.find_element(By.TAG_NAME,'body').text)
 if 'Who are you?' in d.find_element(By.TAG_NAME,'body').text:
  c=[e for e in vis('button') if e.text.strip().lower().startswith(('sam','rocketmansh'))];assert len(c)==1;c[0].click()
 search();time.sleep(3)
 saved=d.execute_script('return Object.fromEntries(Object.entries(localStorage).filter(([k])=>arguments[0].some(p=>k.startsWith(p))))',keys)
 assert 'Werkruimte' in d.find_element(By.TAG_NAME,'body').text
 assert 'Waar werken we aan?' in d.find_element(By.TAG_NAME,'body').text
 assert not d.execute_script('return document.documentElement.scrollWidth>innerWidth')
 vis('[data-rail-sid]')[0].click();shot('overview-first')
 # Filter real rows, then verify opening returns to the same mounted list.
 button('Alle chats').click();search().send_keys('sites');time.sleep(.5)
 rows=vis('[data-rail-sid]');assert rows,'Expected actual sessions in filter'
 row=rows[-1];sid=row.get_attribute('data-rail-sid');row.click();time.sleep(.3)
 scroller=vis('[data-testid="workspace-conversations"]')[0]
 before=d.execute_script('return arguments[0].scrollTop',scroller) if scroller else 0
 button('Open gesprek').click()
 w.until(lambda _:vis('[data-stage-sid="'+sid+'"]'))
 assert not vis('[data-desktop-workspace]'),'Overview should yield to full conversation'
 shot('conversation')
 back=w.until(lambda _:next((e for e in vis('button') if e.text.strip().endswith('Gesprekken')),False));back.click()
 assert search().get_attribute('value')=='sites','Query lost on return'
 assert button('Alle chats').get_attribute('aria-pressed')=='true','Grouping lost'
 if scroller:
  after=d.execute_script('return arguments[0].scrollTop',scroller);print('SCROLL',before,after,flush=True);assert abs(after-before)<=2,'Scroll lost on return'
 print('OPEN_RETURN_OK: same session, query, grouping, scroll',flush=True)
 search().clear();search().send_keys('no-such-desktop-qa-result-1024');time.sleep(.3)
 assert 'Geen gesprekken gevonden' in d.find_element(By.TAG_NAME,'body').text
 assert not vis('[data-rail-sid]'),'Empty search still lists sessions'
 search().clear();search().send_keys(Keys.SPACE,Keys.BACKSPACE);button('Aandacht').click();time.sleep(.4)
 # Preserve a local draft across open/return, without submission.
 areas=vis('textarea');assert areas,'Composer missing';prompt=areas[0];oldprompt=prompt.get_attribute('value') or ''
 prompt.send_keys('desktop QA concept');rows=vis('[data-rail-sid]');rows[0].click();button('Open gesprek').click();w.until(lambda _:vis('[data-stage-sid]'))
 back=w.until(lambda _:next((e for e in vis('button') if e.text.strip().endswith('Gesprekken')),False));back.click();w.until(lambda _:vis('textarea'))
 assert 'desktop QA concept' in vis('textarea')[0].get_attribute('value'),'Draft lost'
 vis('textarea')[0].send_keys(Keys.COMMAND,'a');vis('textarea')[0].send_keys(Keys.BACKSPACE);vis('textarea')[0].send_keys(oldprompt)
 print('DRAFT_RETURN_OK',flush=True)
 # Explicit keyboard open must open a transcript, not only change selection.
 vis('[data-rail-sid]')[0].click();d.execute_script('document.activeElement.blur()')
 ActionChains(d).send_keys('o').perform();w.until(lambda _:vis('[data-stage-sid]'))
 w.until(lambda _:next((e for e in vis('button') if e.get_attribute('aria-label')=='Terug naar gesprekken'),False)).click();search()
 rows=vis('[data-rail-sid]');rows[0].click()
 ActionChains(d).key_down(Keys.SHIFT).click(rows[1]).key_up(Keys.SHIFT).perform()
 w.until(lambda _:len(vis('[data-stage-sid]'))>=2)
 w.until(lambda _:next((e for e in vis('button') if e.get_attribute('aria-label')=='Terug naar gesprekken'),False)).click();search()
 assert not vis('[data-stage-sid]'),'Hidden overview must not keep full transcripts mounted'
 print('KEYBOARD_AND_MULTIPANE_OK',flush=True)
 shot('dark')
 d.execute_script('document.documentElement.classList.remove("dark");document.documentElement.style.colorScheme="light"');time.sleep(.3);shot('light')
 d.execute_script('document.documentElement.classList.add("dark");document.documentElement.style.colorScheme="dark"')
 for width in [1280,1024]:
  setsize(width,850);assert not d.execute_script('return document.documentElement.scrollWidth>innerWidth'),f'Overflow {width}'
  assert search().is_displayed();assert button('Open gesprek').is_displayed();shot(str(width))
 # Direct global navigation keeps using the existing router and pages.
 setsize(1619,971)
 for label,path in [('Instellingen','/settings'),('Computer','/computer')]:
  button(label).click();w.until(lambda _:d.current_url.split('?')[0].rstrip('/').endswith(path))
  assert not vis('[data-desktop-workspace]')
  d.get(a.url);search();w.until(lambda _:vis('[data-desktop-workspace]'))
 print('GLOBAL_NAVIGATION_OK: settings and Computer existing routes',flush=True)
 print('DESKTOP_WORKSPACE_UI_OK: layout, real open/return, empty search, draft retention, light/dark, 1619/1280/1024; no chat submitted',flush=True)
except:
 shot('failure');print('VISIBLE_BUTTONS',[(e.get_attribute('aria-label'),e.text[:60]) for e in vis('button')][-35:],flush=True);raise
finally:
 if saved is not None:d.execute_script('for(const k of Object.keys(localStorage))if(arguments[1].some(p=>k.startsWith(p)))localStorage.removeItem(k);for(const [k,v] of Object.entries(arguments[0]))localStorage.setItem(k,v)',saved,keys)
 d.quit()
