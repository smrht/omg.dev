"""Run via codex-firefox against the owned live-session-proof.py canary only."""
import os,time,json,subprocess
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait,Select
out=Path.home()/'.cache/omg-daybreak-sessions/ui-proof';out.mkdir(exist_ok=True);url='https://agentbox2.tailda028c.ts.net/'
sid=json.loads(subprocess.check_output(['ssh','agent@agentbox2','cat /home/agent/.cache/agent-tmp/omg-daybreak-sessions/qa-session.json'],text=True))['sessionId']
o=Options();o.add_argument('-profile');o.add_argument(os.environ['CODEX_FIREFOX_PROFILE']);d=webdriver.Firefox(options=o);w=WebDriverWait(d,35);saved=None
def vis(css):return [e for e in d.find_elements(By.CSS_SELECTOR,css) if e.is_displayed()]
def program_select():return vis('select[title="Cyber-toegangsprogramma voor dit model"]')
try:
 d.set_window_size(1500,1050);d.get(url);w.until(lambda _:vis('textarea'))
 # Temporary browser-only fixture, restored in memory; never logs auth/state.
 keys=['lfg_v2_agent','lfg_model_codex-aisdk','lfg_v2_project_filter','lfg_v2_user_filter','omg:overview:view'];saved=d.execute_script('return Object.fromEntries(arguments[0].map(k=>[k,localStorage.getItem(k)]))',keys)
 d.execute_script('localStorage.setItem("lfg_v2_agent","codex-aisdk");localStorage.setItem("lfg_model_codex-aisdk","gpt-6-sol")');d.refresh();w.until(lambda _:vis('.workspace-model-controls button[aria-label^="Agent "]'))[0].click();w.until(lambda _:vis('button[title="gpt-6-sol"]'))[0].click();w.until(lambda _:program_select())
 picker=Select(program_select()[0]);assert [x.get_attribute('value') for x in picker.options]==['','standard','daybreakBlue'];picker.select_by_value('daybreakBlue');assert picker.first_selected_option.get_attribute('value')=='daybreakBlue'
 program_select()[0].find_element(By.XPATH,'ancestor::form').screenshot(str(out/'desktop-launch.png'));print('LIVE_DESKTOP_LAUNCH_DAYBREAK_CHOICES_OK',flush=True)
 assert d.execute_async_script('const done=arguments[arguments.length-1];fetch("/api/sessions/"+arguments[0]+"/cyber-access-program",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cyberAccessProgram:"standard"})}).then(r=>done(r.ok))',sid)
 # Existing own canary, menu identity and native keyboard selection.
 d.execute_script('localStorage.setItem("lfg_v2_project_filter","__no_project");localStorage.setItem("lfg_v2_user_filter","__all")');d.get(url+'?session='+sid);w.until(lambda _:vis('button[aria-label="Alle projecten tonen"]'))[0].click();w.until(lambda _:vis(f'[data-stage-sid="{sid}"] button[aria-label="Session menu"]'));vis('button[aria-label="Session menu"]')[-1].click()
 trigger=w.until(lambda _:next((e for e in vis('[data-slot="dropdown-menu-sub-trigger"]') if 'Daybreak' in e.text),None));trigger.click();time.sleep(.4);items=w.until(lambda _:vis('[data-slot="dropdown-menu-radio-item"]'))
 assert {e.text for e in items}=={'Uit','Blue'}
 assert next(e for e in items if e.text=='Uit').get_attribute('aria-checked')=='true'
 # Choose only our fixture chat, then confirm persisted state by API through browser.
 next(e for e in items if e.text=='Blue').click();w.until(lambda _:d.execute_async_script('const sid=arguments[0],done=arguments[arguments.length-1];fetch("/api/sessions").then(r=>r.json()).then(x=>done(x.sessions.find(s=>s.sessionId===sid)?.cyberAccessProgram))',sid)=='daybreakBlue')
 d.get(url+'?session='+sid);w.until(lambda _:vis(f'[data-stage-sid="{sid}"] button[aria-label="Session menu"]'))[-1].click();time.sleep(.4)
 w.until(lambda _:next((e for e in vis('[data-slot="dropdown-menu-sub-trigger"]') if 'Daybreak' in e.text),None)).click();time.sleep(.4)
 w.until(lambda _:next((e for e in vis('[data-slot="dropdown-menu-radio-item"]') if e.text=='Blue' and e.get_attribute('aria-checked')=='true'),None));d.save_screenshot(str(out/'desktop-session.png'));print('LIVE_DESKTOP_SESSION_MENU_SAVE_OK',flush=True)

 # Mobile frame exercises the actual layout breakpoint, not browser chrome.
 d.get(url);w.until(lambda _:vis('textarea'))
 d.execute_script('document.body.replaceChildren();const f=document.createElement("iframe");f.src=arguments[0];f.style.cssText="width:390px;height:844px;border:0";document.body.append(f)',url)
 w.until(lambda _:d.find_elements(By.TAG_NAME,'iframe'));d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'));w.until(lambda _:vis('textarea'))
 btn=w.until(lambda _:next((e for e in vis('button') if (e.get_attribute('aria-label') or '').startswith('Selection:')),None));btn.click();w.until(lambda _:vis('[data-testid="compact-model-picker"]'));w.until(lambda _:vis('button[aria-label="All models"]'))[0].click();w.until(lambda _:vis('button[title="gpt-6-sol"]'))[0].click();select=w.until(lambda _:vis('[data-testid="compact-model-picker"] select'))[0]
 assert [e.get_attribute('value') for e in Select(select).options]==['','standard','daybreakBlue'];Select(select).select_by_value('daybreakBlue');assert not d.execute_script('return document.documentElement.scrollWidth>innerWidth')
 d.switch_to.default_content();d.find_element(By.TAG_NAME,'iframe').screenshot(str(out/'mobile-launch.png'));print('LIVE_MOBILE_COMPACT_PICKER_DAYBREAK_NO_OVERFLOW_OK',flush=True)
 # The same ordinary chat on mobile uses the real session menu.
 d.execute_script('document.querySelector("iframe").src=arguments[0]',url+'sessions/'+sid)
 d.switch_to.frame(d.find_element(By.TAG_NAME,'iframe'));w.until(lambda _:vis('[role="dialog"][aria-label="QA Daybreak gewone chat (tijdelijk)"] button[aria-label="Session menu"]'))[-1].click();time.sleep(.4)
 w.until(lambda _:next((e for e in vis('[data-slot="dropdown-menu-sub-trigger"]') if 'Daybreak' in e.text),None)).click();time.sleep(.4)
 items=w.until(lambda _:vis('[data-slot="dropdown-menu-radio-item"]'));assert next(e for e in items if e.text=='Blue').get_attribute('aria-checked')=='true'
 assert not d.execute_script('return document.documentElement.scrollWidth>innerWidth')
 d.switch_to.default_content();d.find_element(By.TAG_NAME,'iframe').screenshot(str(out/'mobile-session.png'));print('LIVE_MOBILE_ORDINARY_SESSION_MENU_OK',flush=True)
 # Sol 6.1 must not display unavailable Daybreak.
 d.execute_script('localStorage.setItem("lfg_model_codex-aisdk","gpt-6.1-sol")');d.get(url);w.until(lambda _:vis('.workspace-model-controls button[aria-label^="Agent "]'))[0].click();w.until(lambda _:vis('button[title="gpt-6.1-sol"]'))[0].click();time.sleep(.3);assert not program_select();print('LIVE_UNSUPPORTED_SOL61_CONTROL_ABSENT_OK',flush=True)
finally:
 if saved is not None:
  d.switch_to.default_content();d.get(url);d.execute_script('for(const [k,v] of Object.entries(arguments[0])){if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}',saved)
 d.quit()
