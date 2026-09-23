import os,json,time,argparse
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as E
parser=argparse.ArgumentParser();parser.add_argument('--url',required=True);parser.add_argument('--session-id',required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
out=args.output;out.mkdir(parents=True,exist_ok=True)
op=Options();op.add_argument('-profile');op.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);d=webdriver.Firefox(options=op);saved=None
def get_dialog():
 return next(x for x in d.find_elements(By.CSS_SELECTOR,'[role="dialog"]') if x.is_displayed() and 'Continue in a new session' in x.text)
try:
 d.set_window_size(1440,1000);d.get(args.url);w=WebDriverWait(d,30)
 w.until(E.element_to_be_clickable((By.CSS_SELECTOR,'button[aria-label="Pages"]')))
 saved=d.execute_script('return Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith("lfg_v2")||k.startsWith("lfg_fork")))')
 for viewport,width,height in [('desktop',1440,1000),('mobile',430,932)]:
  d.set_window_size(width,height);d.get(args.url)
  ring=w.until(E.element_to_be_clickable((By.CSS_SELECTOR,'button[aria-label*=" usage."]')))
  assert ring.is_displayed();print(json.dumps({'viewport':viewport,'new_session_ring':True,'inner_width':d.execute_script('return innerWidth')}),flush=True)
  d.get(args.url.rstrip('/')+'/?session='+args.session_id)
  w.until(E.element_to_be_clickable((By.CSS_SELECTOR,'button[aria-label="Session menu"]'))).click()
  w.until(E.element_to_be_clickable((By.XPATH,'//*[@role="menuitem" and normalize-space(.)="Continue"]'))).click()
  dialog=w.until(lambda _:next((x for x in d.find_elements(By.CSS_SELECTOR,'[role="dialog"]') if x.is_displayed() and 'Continue in a new session' in x.text),False))
  w.until(lambda _:get_dialog().find_elements(By.CSS_SELECTOR,'button[aria-label*=" usage."]'))
  get_dialog().find_element(By.CSS_SELECTOR,'button[aria-label="opencode"]').click()
  ring=w.until(lambda _:next((b for b in get_dialog().find_elements(By.CSS_SELECTOR,'button[aria-label*=" usage."]') if b.get_attribute('aria-label').startswith('OpenCode')),False))
  ring.click();menu=w.until(E.visibility_of_element_located((By.CSS_SELECTOR,'[role="menu"]')))
  assert 'local stats' in menu.text or 'No limit data' in menu.text or 'Signed in' in menu.text
  assert '%' not in menu.text,'OpenCode must not fabricate quota percentages'
  d.switch_to.active_element.send_keys(Keys.ESCAPE)
  get_dialog().find_element(By.CSS_SELECTOR,'button[aria-label="Model"]').click()
  search=w.until(E.visibility_of_element_located((By.CSS_SELECTOR,'input[placeholder="Filter models"]')));search.send_keys('glm-5.3-flash')
  options=search.find_element(By.XPATH,'../..');option=w.until(lambda _:options.find_element(By.XPATH,'.//button[normalize-space(.)="zai-coding-plan/glm-5.3-flash"]'));w.until(lambda _:d.execute_script('const e=arguments[0],r=e.getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))',option));option.click()
  w.until(lambda _: 'glm-5.3-flash' in get_dialog().find_element(By.CSS_SELECTOR,'button[aria-label="Model"]').text)
  w.until(lambda _:not d.find_elements(By.CSS_SELECTOR,'[data-slot="model-picker-drawer-content"]'))
  get_dialog().screenshot(str(out/(viewport+'-continue.png')))
  # Prove actual quota data on a provider that reports limit windows.
  choices=get_dialog().find_elements(By.CSS_SELECTOR,'button[aria-label="Claude · Auto"]')
  assert choices;choices[0].click()
  ring=w.until(lambda _:next((b for b in get_dialog().find_elements(By.CSS_SELECTOR,'button[aria-label*=" usage."]') if b.get_attribute('aria-label').startswith('Claude')),False));ring.click()
  menu=w.until(E.visibility_of_element_located((By.CSS_SELECTOR,'[role="menu"]')))
  assert '%' in menu.text and ('5 hr' in menu.text or '7 day' in menu.text)
  menu.screenshot(str(out/(viewport+'-usage.png')))
  d.switch_to.active_element.send_keys(Keys.ESCAPE)
  get_dialog().find_element(By.XPATH,'.//button[normalize-space(.)="Cancel"]').click()
  print(json.dumps({'viewport':viewport,'continue_ring':True,'flash_selectable':True,'claude_live_percentages':True,'opencode_no_fabricated_quota':True,'chat_submitted':False}),flush=True)
finally:
 if saved is not None:
  d.execute_script('for(const k of Object.keys(localStorage)){if(k.startsWith("lfg_v2")||k.startsWith("lfg_fork"))localStorage.removeItem(k)};for(const [k,v] of Object.entries(arguments[0]))localStorage.setItem(k,v)',saved)
 d.quit()
